// From a verified webhook to a deployed build. A webhook only says "go and look": each delivery re-reads
// the branch head from the provider and deploys that, so a captured push cannot bring an old commit back.
// Delivery rows are the queue. A row moves queued -> resolving -> building -> deployed | skipped | failed,
// and only a stable code is ever stored, because runtime and provider text can quote a credential.

import type { Deps } from "../app.ts";
import { appUrl, orgClient } from "../apps/service.ts";
import { audit } from "../audit/audit.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { rateLimited } from "../auth/ratelimit.ts";
import { hex, sha256, sha256Hex } from "../crypto/hash.ts";
import { AppError, notFound } from "../http/errors.ts";
import { json } from "../http/json.ts";
import { verifyWebhook } from "../hooks/verify.ts";
import { rethrowBudget } from "../jobs/budget.ts";
import type { Job, RunnerDeps } from "../jobs/runner.ts";
import { getOrg } from "../orgs/orgs.ts";
import { isNotFound, RuntimeError, RuntimeUnavailable, type Scoped } from "../runtime/client.ts";
import { hookSecretContext, tokenContext, type LinkRow, type RuleRow } from "./links.ts";
import { closePreview, ensurePreviewService, holdPreview, MAX_PREVIEWS, previewCount, previewEnvOf, previewOf } from "./previews.ts";
import {
  archiveUrl, authHeaders, confirmedNotFork, deliveryId, fetchHead, fetchPullHead, globMatch, parsePull, parsePush, postStatus, readCapped, type CommitState, type HeadResult, type PullEvent,
} from "./provider.ts";

const MAX_BODY = 1 << 20;
const HOOKS_PER_MINUTE = 60;
const HOOK_RE = /^ghk_[A-Za-z0-9_-]{16,64}$/;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const LEASE_MS = 120_000;
const BUILD_POLL_MS = 30_000;
const BUILD_DEADLINE_MS = 30 * 60_000;
const RETENTION_MS = 30 * 86_400_000;
const BATCH = 5;
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TERMINAL = "('deployed','skipped','failed')";

type GitDeps = Pick<Deps, "storage" | "now" | "config" | "rtctl" | "fetch">;

interface DeliveryRow {
  hook_id: string;
  event: string;
  ref: string;
  sha: string;
  state: string;
  version: number | null;
  received_at: number;
  next_at: number | null;
  head_sha: string | null;
  target_id: string | null;
  target_branch: string | null;
  activate: number;
  fork: number;
  attempts: number;
  [k: string]: unknown;
}

const NOT_FOUND = () => notFound();

// The route's limits on version meta, in bytes.
const META_TEXT_BYTES = 256;
const META_MESSAGE_BYTES = 1024;

/** Cuts at a character boundary: a provider's name can be 100 characters of 4 bytes. */
function capBytes(s: string, max: number): string {
  const b = new TextEncoder().encode(s);
  if (b.length <= max) return s;
  let end = max;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(b.subarray(0, end));
}

/** Which rule of a push applies: the most specific pattern, so `feature/x` beats `feature/*`. */
export function ruleFor(rules: readonly RuleRow[], branch: string): RuleRow | null {
  const hits = rules.filter((r) => globMatch(r.ref_pattern, branch));
  hits.sort((a, b) => b.ref_pattern.replaceAll("*", "").length - a.ref_pattern.replaceAll("*", "").length || a.ref_pattern.localeCompare(b.ref_pattern));
  return hits[0] ?? null;
}

const fetchOf = (deps: Pick<Deps, "fetch">): typeof fetch => deps.fetch ?? globalThis.fetch.bind(globalThis);

/**
 * POST /api/hooks/git/{hook}. Throttled per hook id before anything is looked up, so an unknown id costs the
 * same as a known one, and every way of failing the check answers the same 404.
 */
export async function receiveWebhook(deps: Deps, hook: string, req: Request, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  if (!HOOK_RE.test(hook)) throw NOT_FOUND();
  const n = await deps.storage.kv.incr(`rl:githook:${await sha256Hex(hook)}`, 1, { ttlSeconds: 60 });
  if (n > HOOKS_PER_MINUTE) throw rateLimited(60);
  const raw = req.body ? await readCapped(req.body, MAX_BODY) : new Uint8Array();
  if (!raw) throw new AppError(413, "too_large", "body too large");

  const db = await dbOf(deps);
  const link = await db.first<LinkRow>("SELECT * FROM git_links WHERE hook_id = ?", [hook]);
  if (!link) throw NOT_FOUND();
  const secret = await openSealed(deps, link.hook_secret_sealed, hookSecretContext(hook));
  if (secret === null || !(await verifyWebhook(link.provider, req.headers, raw, secret))) throw NOT_FOUND();

  const pull = parsePull(link, req.headers, raw);
  if (pull) return receivePull(deps, link, pull, req.headers, waitUntil);
  const push = parsePush(link, req.headers, raw);
  if (!push) return json({ status: "ignored" }, 202);
  if (push.branch !== link.branch) {
    const rules = await db.all<RuleRow>("SELECT * FROM git_branch_rules WHERE link_id = ?", [link.app_id]);
    if (!ruleFor(rules, push.branch)) return json({ status: "ignored" }, 202);
  }
  const now = deps.now();
  // A finished row is queued again rather than dropped: a force push back to an older commit is real, and
  // the head check below is what tells it from a replay.
  const out = await db.run(
    `INSERT INTO git_deliveries (hook_id, event, ref, sha, delivery_id, state, received_at, next_at, fork)
     VALUES (?, 'push', ?, ?, ?, 'queued', ?, ?, ?)
     ON CONFLICT (hook_id, event, ref, sha) DO UPDATE SET
       state = 'queued', delivery_id = excluded.delivery_id, received_at = excluded.received_at,
       next_at = excluded.next_at, fork = excluded.fork, error = NULL, attempts = 0
     WHERE git_deliveries.state IN ${TERMINAL}`,
    [hook, push.ref, push.sha, deliveryId(link.provider, req.headers), now, now, push.fork ? 1 : 0],
  );
  if (out.changes === 0) return json({ status: "duplicate" }, 202);
  if (waitUntil) {
    const row = await db.first<DeliveryRow>("SELECT * FROM git_deliveries WHERE hook_id = ? AND event = 'push' AND ref = ? AND sha = ?", [hook, push.ref, push.sha]);
    // Saves waiting for the next tick. A failure here leaves the row due, and the job takes it.
    if (row) waitUntil(step(deps, row).catch((e: unknown) => console.error("git: delivery step failed", codeOf(e))));
  }
  return json({ status: "queued" }, 202);
}

async function receivePull(deps: Deps, link: LinkRow, pull: PullEvent, headers: Headers, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const db = await dbOf(deps);
  // A renamed repository can be taken over by name: the first signed event pins its number.
  if (pull.repoId === null || (link.repo_id !== null && link.repo_id !== undefined && link.repo_id !== pull.repoId)) return json({ status: "ignored" }, 202);
  if (link.repo_id === null || link.repo_id === undefined) await db.run("UPDATE git_links SET repo_id = ? WHERE hook_id = ? AND repo_id IS NULL", [pull.repoId, link.hook_id]);
  if (pull.action === "close") {
    await closePreview(deps, link, pull.pr);
    return json({ status: "closed" }, 202);
  }
  if (link.previews !== 1) return json({ status: "ignored" }, 202);
  const now = deps.now();
  const ref = `refs/pr/${pull.pr}`;
  await db.run("UPDATE previews SET head_repo_id = ? WHERE app_id = ? AND org_id = ? AND pr = ?", [pull.headRepoId, link.app_id, link.org_id, pull.pr]);
  const out = await db.run(
    `INSERT INTO git_deliveries (hook_id, event, ref, sha, delivery_id, state, received_at, next_at, fork)
     VALUES (?, 'pr', ?, ?, ?, 'queued', ?, ?, ?)
     ON CONFLICT (hook_id, event, ref, sha) DO UPDATE SET
       state = 'queued', delivery_id = excluded.delivery_id, received_at = excluded.received_at,
       next_at = excluded.next_at, fork = excluded.fork, error = NULL, attempts = 0
     WHERE git_deliveries.state IN ${TERMINAL}`,
    [link.hook_id, ref, pull.sha, deliveryId(link.provider, headers), now, now, pull.fork ? 1 : 0],
  );
  if (out.changes === 0) return json({ status: "duplicate" }, 202);
  if (waitUntil) {
    const row = await db.first<DeliveryRow>(`SELECT * FROM git_deliveries ${WHERE_ROW}`, [link.hook_id, "pr", ref, pull.sha]);
    if (row) waitUntil(step(deps, row).catch((e: unknown) => console.error("git: delivery step failed", codeOf(e))));
  }
  return json({ status: "queued" }, 202);
}

async function openSealed(deps: Pick<Deps, "storage" | "config">, sealed: Uint8Array, context: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await (await sealerOf(deps)).open(new Uint8Array(sealed), context));
  } catch {
    console.error("git: a sealed value did not open");
    return null;
  }
}

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && CODE_RE.test(code) ? code : "deploy_failed";
}

const retryable = (e: unknown) =>
  e instanceof RuntimeUnavailable || (e instanceof RuntimeError && (e.status >= 500 || e.status === 429 || e.status === 409));

const key = (r: DeliveryRow) => [r.hook_id, r.event, r.ref, r.sha];
const WHERE_ROW = "WHERE hook_id = ? AND event = ? AND ref = ? AND sha = ?";

async function finish(deps: GitDeps, r: DeliveryRow, state: "skipped" | "failed" | "deployed", error: string | null): Promise<void> {
  await deps.storage.db.run(`UPDATE git_deliveries SET state = ?, error = ?, next_at = NULL ${WHERE_ROW}`, [state, error, ...key(r)]);
}

async function retryLater(deps: GitDeps, r: DeliveryRow, code: string): Promise<void> {
  const attempts = r.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return finish(deps, r, "failed", code);
  const at = deps.now() + RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6);
  await deps.storage.db.run(`UPDATE git_deliveries SET state = 'queued', error = ?, next_at = ? ${WHERE_ROW}`, [code, at, ...key(r)]);
}

async function context(deps: GitDeps, r: DeliveryRow): Promise<{ link: LinkRow; cli: Scoped; token: string | null } | null> {
  const db = deps.storage.db;
  const link = await db.first<LinkRow>("SELECT * FROM git_links WHERE hook_id = ?", [r.hook_id]);
  if (!link) return null;
  const org = await getOrg(await dbOf(deps), link.org_id);
  if (!org) return null;
  const token = link.token_sealed ? await openSealed(deps, link.token_sealed, tokenContext(r.hook_id)) : null;
  return { link, cli: await orgClient(deps as Deps, org), token };
}

/** Takes one due delivery one step further. Safe to run twice: each step claims its row. */
async function step(deps: GitDeps, r: DeliveryRow): Promise<void> {
  try {
    if (r.state === "building") await buildStep(deps, r);
    else await resolveStep(deps, r);
  } catch (e) {
    rethrowBudget(e);
    const code = codeOf(e);
    console.error("git: delivery failed", code);
    if (retryable(e)) await retryLater(deps, r, code);
    else await finish(deps, r, "failed", code);
  }
}

async function resolveStep(deps: GitDeps, r: DeliveryRow): Promise<void> {
  const db = deps.storage.db;
  const now = deps.now();
  // One deployment per ref at a time, so two pushes in quick succession cannot both pass the head check.
  const claim = await db.run(
    `UPDATE git_deliveries SET state = 'resolving', next_at = ? ${WHERE_ROW} AND state = ? AND next_at = ?
     AND NOT EXISTS (SELECT 1 FROM git_deliveries o WHERE o.hook_id = ? AND o.ref = ? AND o.sha <> ? AND o.state = 'resolving' AND o.next_at > ?)`,
    [now + LEASE_MS, ...key(r), r.state, r.next_at ?? 0, r.hook_id, r.ref, r.sha, now],
  );
  if (claim.changes === 0) return;

  const ctx = await context(deps, r);
  if (!ctx) return finish(deps, r, "failed", "link_gone");
  const { link, cli, token } = ctx;
  if (link.token_sealed && token === null) return finish(deps, r, "failed", "token_unreadable");
  if (r.event === "pr") return previewStep(deps, r, link, cli, token);
  const branch = r.ref.slice("refs/heads/".length);
  const f = fetchOf(deps);

  const head: HeadResult = await fetchHead(f, link, branch, token);
  if (head.kind === "retry") return retryLater(deps, r, "head_check_unavailable");
  let sha: string;
  let meta: { author: string; message: string } = { author: "", message: "" };
  if (head.kind === "head") {
    sha = head.sha;
    meta = head;
    const last = await db.first<{ sha: string }>("SELECT sha FROM git_refs WHERE hook_id = ? AND ref = ?", [r.hook_id, r.ref]);
    if (last?.sha === sha) return finish(deps, r, "skipped", "already_deployed");
  } else {
    // A linked token that cannot read the head says nothing is known: deploying the hint would trust the webhook.
    if (token !== null) return finish(deps, r, "failed", "head_check_failed");
    // No credential and a host that will not say. All that is left is to never deploy the same commit twice.
    sha = r.sha;
    const seen = await db.first(
      `SELECT 1 AS x FROM git_deliveries WHERE hook_id = ? AND deployed_at IS NOT NULL AND (head_sha = ? OR sha = ?)`,
      [r.hook_id, sha, sha],
    );
    if (seen) return finish(deps, r, "skipped", "already_deployed");
  }

  let targetId = link.app_id;
  let targetBranch: string | null = null;
  let activate = link.auto_promote === 1 && link.paused === 0;
  if (branch !== link.branch) {
    const rules = await db.all<RuleRow>("SELECT * FROM git_branch_rules WHERE link_id = ?", [link.app_id]);
    const rule = ruleFor(rules, branch);
    if (!rule) return finish(deps, r, "skipped", "no_rule");
    const known = (await cli.listBranches(link.app_id)).find((b) => b.scratch?.name === rule.branch_name);
    const created = known ?? (await cli.createBranch(link.app_id, { name: rule.branch_name }, `git-branch-${await sha256Hex(`${link.app_id}|${rule.branch_name}`)}`));
    targetId = created.id;
    targetBranch = rule.branch_name;
    activate = true;
  }

  const headers = authHeaders(link.provider, token);
  const body = {
    url: archiveUrl(link, sha),
    ...(headers ? { headers } : {}),
    strip_components: 1,
    ...(link.subdir ? { subdir: link.subdir } : {}),
    compile: "eager",
    activate: activate ? "after_build" : null,
    meta: { git: { sha, ref: r.ref, repo: link.repo, author: capBytes(meta.author, META_TEXT_BYTES), message: capBytes(meta.message, META_MESSAGE_BYTES) } },
  } as const;
  // The route replays a lost answer under the same key, and refuses the key for a different request
  // with a 422 that would end the delivery. So everything it fingerprints is in the key, credentials aside.
  const shape = JSON.stringify([targetId, link.subdir, body.activate, body.meta]);
  const idem = hex(await sha256(`${r.hook_id}|${r.ref}|${sha}|${r.received_at}|${shape}`));
  const v = await cli.fromUrl(targetId, body, idem);
  const at = deps.now();
  await db.batch([
    {
      sql: `UPDATE git_deliveries SET state = 'building', version = ?, head_sha = ?, target_id = ?, target_branch = ?, activate = ?, error = NULL, next_at = ?, deployed_at = ? ${WHERE_ROW}`,
      args: [v.version, sha, targetId, targetBranch, activate ? 1 : 0, at, at, ...key(r)],
    },
    {
      sql: "INSERT INTO git_refs (hook_id, ref, sha, deployed_at) VALUES (?, ?, ?, ?) ON CONFLICT (hook_id, ref) DO UPDATE SET sha = excluded.sha, deployed_at = excluded.deployed_at",
      args: [r.hook_id, r.ref, sha, at],
    },
  ]);
  if (token) await postStatus(f, link, sha, token, "pending", await targetUrl(deps, cli, targetId));
}

/**
 * One pull request to its preview. The host's answer decides the head and the origin. A fork's commit runs
 * only once a project admin approved that exact SHA, and gets the preview env only if they said so.
 */
async function previewStep(deps: GitDeps, r: DeliveryRow, link: LinkRow, cli: Scoped, token: string | null): Promise<void> {
  const db = deps.storage.db;
  if (link.previews !== 1) return finish(deps, r, "skipped", "previews_off");
  const pr = Number(r.ref.slice("refs/pr/".length));
  const f = fetchOf(deps);
  const head = await fetchPullHead(f, link, pr, token);
  if (head.kind === "retry") return retryLater(deps, r, "head_check_unavailable");
  if (head.kind === "denied" && token !== null) return finish(deps, r, "failed", "head_check_failed");
  if (head.kind === "head" && !head.open) return finish(deps, r, "skipped", "pr_closed");
  const sha = head.kind === "head" ? head.sha : r.sha;
  // Once either says fork, it is a fork. A host that will not answer leaves only the signed event.
  const fork = r.fork === 1 || (head.kind === "head" && head.fork);
  const last = await db.first<{ sha: string }>("SELECT sha FROM git_refs WHERE hook_id = ? AND ref = ?", [r.hook_id, r.ref]);
  if (last?.sha === sha) return finish(deps, r, "skipped", "already_deployed");

  const now = deps.now();
  const existing = await previewOf(deps, link, pr);
  const approved = !fork || existing?.approved_sha === sha;
  if (!approved) {
    await holdPreview(deps, link, pr, r.ref, sha, now);
    return finish(deps, r, "skipped", "awaiting_approval");
  }
  if (!existing && (await previewCount(deps, link)) >= MAX_PREVIEWS) return finish(deps, r, "failed", "preview_limit");
  const svc = await ensurePreviewService(deps, cli, link, pr, r.ref, sha, fork, existing);
  await cli.putEnv(svc.service_id, !fork || existing?.approved_with_env === 1 ? await previewEnvOf(deps, link) : {});

  const headers = authHeaders(link.provider, token);
  const meta = head.kind === "head" ? head : { author: "", message: "" };
  const body = {
    url: archiveUrl(link, sha),
    ...(headers ? { headers } : {}),
    strip_components: 1,
    ...(link.subdir ? { subdir: link.subdir } : {}),
    compile: "eager",
    activate: "after_build",
    meta: { git: { sha, ref: `refs/heads/pr-${pr}`, repo: link.repo, author: capBytes(meta.author, META_TEXT_BYTES), message: capBytes(meta.message, META_MESSAGE_BYTES) } },
  } as const;
  const idem = hex(await sha256(`${r.hook_id}|${r.ref}|${sha}|${r.received_at}|${JSON.stringify([svc.service_id, link.subdir])}`));
  const v = await cli.fromUrl(svc.service_id, body, idem);
  const at = deps.now();
  await db.batch([
    {
      sql: `UPDATE git_deliveries SET state = 'building', version = ?, head_sha = ?, target_id = ?, target_branch = NULL, activate = 1, error = NULL, next_at = ?, deployed_at = ? ${WHERE_ROW}`,
      args: [v.version, sha, svc.service_id, at, at, ...key(r)],
    },
    {
      sql: "INSERT INTO git_refs (hook_id, ref, sha, deployed_at) VALUES (?, ?, ?, ?) ON CONFLICT (hook_id, ref) DO UPDATE SET sha = excluded.sha, deployed_at = excluded.deployed_at",
      args: [r.hook_id, r.ref, sha, at],
    },
    { sql: "UPDATE previews SET sha = ?, held = 0, fork = ?, last_deploy_at = ? WHERE service_id = ?", args: [sha, fork ? 1 : 0, at, svc.service_id] },
  ]);
  if (token) await postStatus(f, link, sha, token, "pending", await targetUrl(deps, cli, svc.service_id));
}

async function targetUrl(deps: GitDeps, cli: Scoped, id: string): Promise<string | null> {
  const { value } = await cli.getService(id);
  const url = appUrl(deps.config.runtimePublicUrl, value.slug);
  // A relative URL means the node has no public address, and a provider would refuse it.
  return url.startsWith("https://") || url.startsWith("http://") ? url : null;
}

async function buildStep(deps: GitDeps, r: DeliveryRow): Promise<void> {
  const db = deps.storage.db;
  const now = deps.now();
  const claim = await db.run(`UPDATE git_deliveries SET next_at = ? ${WHERE_ROW} AND state = 'building' AND next_at = ?`, [now + BUILD_POLL_MS, ...key(r), r.next_at ?? 0]);
  if (claim.changes === 0) return;
  const ctx = await context(deps, r);
  if (!ctx) return finish(deps, r, "failed", "link_gone");
  const { link, cli, token } = ctx;
  if (r.target_id === null || r.version === null || r.head_sha === null) return finish(deps, r, "failed", "deploy_failed");
  const f = fetchOf(deps);
  const report = async (state: CommitState) => {
    if (token) await postStatus(f, link, r.head_sha as string, token, state, await targetUrl(deps, cli, r.target_id as string));
  };
  let v;
  try {
    v = await cli.getVersion(r.target_id, r.version);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return finish(deps, r, "failed", "target_gone");
  }
  const overdue = now - r.received_at > BUILD_DEADLINE_MS;
  // A commit that never went live does not count as deployed: pushing it again must be able to retry it.
  const failed = async (code: string) => {
    await db.batch([
      { sql: `UPDATE git_deliveries SET state = 'failed', error = ?, next_at = NULL, deployed_at = NULL ${WHERE_ROW}`, args: [code, ...key(r)] },
      { sql: "DELETE FROM git_refs WHERE hook_id = ? AND ref = ? AND sha = ?", args: [r.hook_id, r.ref, r.head_sha] },
    ]);
    await report("failure");
  };
  // fetching, pending and building all wait here. A failed fetch and a failed build both end on the version.
  if (v.build_state === "failed") {
    const code = v.failure?.code;
    return failed(typeof code === "string" && CODE_RE.test(code) ? code : "build_failed");
  }
  if (v.build_state !== "ready") return overdue ? failed("build_timeout") : undefined;
  if (r.activate === 1) {
    const { value: svc } = await cli.getService(r.target_id);
    // The runtime promotes by itself once the build is done; a refused promote never reaches this version.
    if (svc.live_version !== r.version) return overdue ? failed("activation_timeout") : undefined;
  }
  await finish(deps, r, "deployed", null);
  await report("success");
  if (r.target_branch !== null) await autoSwitch(deps, r, link, cli, token);
}

/**
 * Switching is the privilege boundary: branch code receives production secrets. So this is opt-in per rule,
 * off while paused, refused for a fork on the provider's word rather than the hook's, and only for the
 * commit that is still the head.
 */
async function autoSwitch(deps: GitDeps, r: DeliveryRow, link: LinkRow, cli: Scoped, token: string | null): Promise<void> {
  const db = deps.storage.db;
  const rule = await db.first<RuleRow>("SELECT * FROM git_branch_rules WHERE link_id = ? AND branch_name = ? AND auto_switch = 1 AND paused = 0", [link.app_id, r.target_branch as string]);
  if (!rule || link.paused === 1 || r.fork === 1) return;
  if (link.token_sealed !== null && token === null) return;
  const f = fetchOf(deps);
  const branch = r.ref.slice("refs/heads/".length);
  if (!globMatch(rule.ref_pattern, branch)) return;
  const head = await fetchHead(f, link, branch, token);
  if (head.kind !== "head" || head.sha !== r.head_sha) return;
  if (!(await confirmedNotFork(f, link, token))) return;
  try {
    const { etag } = await cli.getService(link.app_id);
    const out = await cli.switchTo(link.app_id, { from: { branch: r.target_branch as string }, close_sockets: false, dry_run: false }, etag);
    await audit(deps as Deps, {
      actor: {}, orgId: link.org_id, action: "app.switch", target: link.app_id,
      detail: { branch: r.target_branch, switch: out.id ?? null, sha: r.head_sha, trigger: "git" },
    });
  } catch (e) {
    rethrowBudget(e);
    const code = codeOf(e);
    console.error("git: auto switch failed", code);
    await db.run(`UPDATE git_deliveries SET error = ? ${WHERE_ROW}`, [`auto_switch_${code}`.slice(0, 64), ...key(r)]);
  }
}

/** A tokenless link has nothing but its deployed rows to refuse a replay with, so those stay. */
async function prune(deps: GitDeps): Promise<void> {
  await deps.storage.db.run(
    `DELETE FROM git_deliveries WHERE received_at < ? AND state IN ${TERMINAL}
     AND (deployed_at IS NULL OR hook_id IN (SELECT hook_id FROM git_links WHERE token_sealed IS NOT NULL))`,
    [deps.now() - RETENTION_MS],
  );
}

export const GIT_DELIVERIES_JOB: Job = {
  name: "git_deliveries",
  everyMs: 60_000,
  run: async ({ deps }: { deps: RunnerDeps & { fetch: typeof fetch } }) => {
    if (!deps.rtctl) return undefined;
    await prune(deps);
    const due = await deps.storage.db.all<DeliveryRow>(
      `SELECT * FROM git_deliveries WHERE state IN ('queued','resolving','building') AND next_at <= ? ORDER BY next_at LIMIT ?`,
      [deps.now(), BATCH + 1],
    );
    for (const r of due.slice(0, BATCH)) await step(deps, r);
    return due.length > BATCH ? { cursor: "more" } : undefined;
  },
};
