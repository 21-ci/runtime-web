// A link between an App and a Git repository, plus its branch rules. base_url, provider and repo never
// change: if they could, a developer-reachable edit could send the stored token to a host of their choosing,
// so moving a link means deleting it, which forgets the token and the secret.

import type { Deps } from "../app.ts";
import { assertPublicHost } from "../auth/oauth.ts";
import { dbOf, sealerOf } from "../auth/types.ts";
import { randomBytes, base64url } from "../crypto/random.ts";
import { AppError, conflict, invalid } from "../http/errors.ts";
import type { Row } from "../storage/types.ts";
import { appFor, type OrgCtx } from "../apps/service.ts";
import { isGitTestOrigin, parseBaseUrl, PROVIDERS, validBranch, validPattern, validRepo, validSubdir, type Provider } from "./provider.ts";

export const hookSecretContext = (hook: string) => `git.hook_secret:${hook}`;
export const tokenContext = (hook: string) => `git.token:${hook}`;

export const BRANCH_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const MAX_RULES = 20;
const DELIVERIES_SHOWN = 20;
const TOKEN_RE = /^[\x21-\x7e]{1,1024}$/;

export interface LinkRow extends Row {
  app_id: string;
  org_id: string;
  provider: Provider;
  base_url: string;
  repo: string;
  branch: string;
  subdir: string | null;
  auto_promote: number;
  paused: number;
  hook_id: string;
  hook_secret_sealed: Uint8Array;
  token_sealed: Uint8Array | null;
  created_by: string;
  created_at: number;
  previews?: number;
  repo_id?: number | null;
}

export interface RuleRow extends Row {
  link_id: string;
  ref_pattern: string;
  branch_name: string;
  auto_switch: number;
  paused: number;
}

const enc = new TextEncoder();

function linkView(l: LinkRow) {
  return {
    provider: l.provider,
    base_url: l.base_url,
    repo: l.repo,
    branch: l.branch,
    subdir: l.subdir,
    auto_promote: l.auto_promote === 1,
    paused: l.paused === 1,
    hook_id: l.hook_id,
    has_token: l.token_sealed !== null,
    previews: l.previews === 1,
    created_at: l.created_at,
  };
}

const ruleView = (r: RuleRow) => ({ ref_pattern: r.ref_pattern, branch_name: r.branch_name, auto_switch: r.auto_switch === 1, paused: r.paused === 1 });

const webhookUrl = (deps: Deps, hook: string) => `${deps.config.origin}/api/hooks/git/${hook}`;

async function linkOf(c: OrgCtx, appId: string): Promise<LinkRow | null> {
  return (await dbOf(c.deps)).first<LinkRow>("SELECT * FROM git_links WHERE app_id = ? AND org_id = ?", [appId, c.org.id]);
}

const rulesOf = async (deps: Deps, appId: string) =>
  (await dbOf(deps)).all<RuleRow>("SELECT * FROM git_branch_rules WHERE link_id = ? ORDER BY ref_pattern", [appId]);

export async function getLink(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.git.manage");
  const l = await linkOf(c, app.id);
  if (!l) return { link: null, rules: [], deliveries: [] };
  const deliveries = await (await dbOf(c.deps)).all(
    `SELECT ref, sha, head_sha, state, version, error, target_branch, received_at FROM git_deliveries
     WHERE hook_id = ? ORDER BY received_at DESC LIMIT ?`,
    [l.hook_id, DELIVERIES_SHOWN],
  );
  return {
    link: { ...linkView(l), webhook_url: webhookUrl(c.deps, l.hook_id) },
    rules: (await rulesOf(c.deps, app.id)).map(ruleView),
    deliveries,
  };
}

const CREATE_FIELDS = new Set(["provider", "base_url", "repo", "branch", "subdir", "auto_promote", "token"]);

export async function createLink(c: OrgCtx, slug: string, b: Record<string, unknown>) {
  const app = await appFor(c, slug, "app.git.manage");
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!CREATE_FIELDS.has(k)) fields[k] = "unknown";
  const provider = PROVIDERS.includes(b.provider as Provider) ? (b.provider as Provider) : null;
  if (!provider) fields.provider = "not_one_of";
  const base = parseBaseUrl(b.base_url);
  if (!base) fields.base_url = "not_public_https_origin";
  if (provider && !validRepo(provider, b.repo)) fields.repo = "pattern";
  if (!validBranch(b.branch)) fields.branch = "pattern";
  if (b.subdir !== undefined && b.subdir !== null && !validSubdir(b.subdir)) fields.subdir = "pattern";
  if (b.auto_promote !== undefined && typeof b.auto_promote !== "boolean") fields.auto_promote = "not_boolean";
  if (b.token !== undefined && (typeof b.token !== "string" || !TOKEN_RE.test(b.token))) fields.token = "pattern";
  if (Object.keys(fields).length) throw invalid(fields);
  if (await linkOf(c, app.id)) throw conflict("git_link_exists", "this app already has a repository link");
  try {
    if (!isGitTestOrigin(base as string)) await assertPublicHost(c.deps, new URL(base as string).hostname.replace(/\.+$/, ""));
  } catch {
    throw invalid({ base_url: "not_public" });
  }

  const hook = `ghk_${base64url(randomBytes(18))}`;
  const secret = base64url(randomBytes(32));
  const s = await sealerOf(c.deps);
  const token = typeof b.token === "string" ? await s.seal(enc.encode(b.token), tokenContext(hook)) : null;
  const db = await dbOf(c.deps);
  try {
    await db.run(
      `INSERT INTO git_links (app_id, org_id, provider, base_url, repo, branch, subdir, auto_promote, hook_id, hook_secret_sealed, token_sealed, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        app.id, c.org.id, provider as string, base as string, b.repo as string, b.branch as string,
        (b.subdir as string | null | undefined) ?? null, b.auto_promote === false ? 0 : 1, hook,
        await s.seal(enc.encode(secret), hookSecretContext(hook)), token, c.sub.userId, c.deps.now(),
      ],
    );
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("git_link_exists", "this app already has a repository link");
    throw e;
  }
  return {
    provider, base_url: base, repo: b.repo, branch: b.branch, subdir: b.subdir ?? null, auto_promote: b.auto_promote !== false, paused: false,
    hook_id: hook, hook_secret: secret, webhook_url: webhookUrl(c.deps, hook), has_token: token !== null,
  };
}

const IMMUTABLE = ["base_url", "provider", "repo"];
const PATCH_FIELDS = new Set(["branch", "subdir", "auto_promote", "paused", "token", "previews"]);

export async function updateLink(c: OrgCtx, slug: string, b: Record<string, unknown>) {
  const app = await appFor(c, slug, "app.git.manage");
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) {
    if (IMMUTABLE.includes(k)) fields[k] = "immutable";
    else if (!PATCH_FIELDS.has(k)) fields[k] = "unknown";
  }
  if (b.branch !== undefined && !validBranch(b.branch)) fields.branch = "pattern";
  if (b.subdir !== undefined && b.subdir !== null && !validSubdir(b.subdir)) fields.subdir = "pattern";
  for (const k of ["auto_promote", "paused", "previews"]) if (b[k] !== undefined && typeof b[k] !== "boolean") fields[k] = "not_boolean";
  if (b.token !== undefined && b.token !== null && (typeof b.token !== "string" || !TOKEN_RE.test(b.token))) fields.token = "pattern";
  if (Object.keys(fields).length) throw invalid(fields);
  const l = await linkOf(c, app.id);
  if (!l) throw new AppError(404, "not_found", "not found");
  const next = {
    branch: (b.branch as string | undefined) ?? l.branch,
    subdir: b.subdir === undefined ? l.subdir : (b.subdir as string | null),
    auto_promote: b.auto_promote === undefined ? l.auto_promote : Number(b.auto_promote),
    paused: b.paused === undefined ? l.paused : Number(b.paused),
    previews: b.previews === undefined ? (l.previews ?? 0) : Number(b.previews),
    token: l.token_sealed,
  };
  if (b.token === null) next.token = null;
  if (typeof b.token === "string") next.token = await (await sealerOf(c.deps)).seal(enc.encode(b.token), tokenContext(l.hook_id));
  await (await dbOf(c.deps)).run(
    "UPDATE git_links SET branch = ?, subdir = ?, auto_promote = ?, paused = ?, previews = ?, token_sealed = ? WHERE app_id = ? AND org_id = ?",
    [next.branch, next.subdir, next.auto_promote, next.paused, next.previews, next.token, app.id, c.org.id],
  );
  return linkView({ ...l, ...next, token_sealed: next.token });
}

export async function deleteLink(c: OrgCtx, slug: string): Promise<void> {
  const app = await appFor(c, slug, "app.git.manage");
  const l = await linkOf(c, app.id);
  if (!l) throw new AppError(404, "not_found", "not found");
  await removeLinkOf(c.deps, c.org.id, app.id);
}

/** Forgets everything about an App's link. Nothing to do when it has none. */
export async function removeLinkOf(deps: Pick<Deps, "storage" | "config">, orgId: string, appId: string): Promise<void> {
  const db = deps.storage.db;
  const l = await db.first<{ hook_id: string }>("SELECT hook_id FROM git_links WHERE app_id = ? AND org_id = ?", [appId, orgId]);
  if (!l) return;
  await db.batch([
    { sql: "DELETE FROM git_branch_rules WHERE link_id = ?", args: [appId] },
    { sql: "DELETE FROM git_deliveries WHERE hook_id = ?", args: [l.hook_id] },
    { sql: "DELETE FROM git_refs WHERE hook_id = ?", args: [l.hook_id] },
    { sql: "DELETE FROM git_links WHERE app_id = ?", args: [appId] },
  ]);
}

const RULE_FIELDS = new Set(["ref_pattern", "branch_name", "auto_switch", "paused"]);

/** Replaces the rule set. Each rule names the one branch that a push matching its pattern deploys to. */
export async function putRules(c: OrgCtx, slug: string, b: Record<string, unknown>) {
  const app = await appFor(c, slug, "app.git.manage");
  const list = b.rules;
  if (!Array.isArray(list) || list.length > MAX_RULES) throw invalid({ rules: "out_of_range" });
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  list.forEach((raw: unknown, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!RULE_FIELDS.has(k)) fields[`rules.${i}.${k}`] = "unknown";
    if (!validPattern(r.ref_pattern)) fields[`rules.${i}.ref_pattern`] = "pattern";
    else if (seen.has(r.ref_pattern)) fields[`rules.${i}.ref_pattern`] = "duplicate";
    else seen.add(r.ref_pattern);
    if (typeof r.branch_name !== "string" || !BRANCH_NAME_RE.test(r.branch_name) || r.branch_name.includes("--")) fields[`rules.${i}.branch_name`] = "pattern";
    for (const k of ["auto_switch", "paused"]) if (r[k] !== undefined && typeof r[k] !== "boolean") fields[`rules.${i}.${k}`] = "not_boolean";
  });
  if (Object.keys(fields).length) throw invalid(fields);
  if (!(await linkOf(c, app.id))) throw new AppError(404, "not_found", "not found");
  const rows = list as { ref_pattern: string; branch_name: string; auto_switch?: boolean; paused?: boolean }[];
  await (await dbOf(c.deps)).batch([
    { sql: "DELETE FROM git_branch_rules WHERE link_id = ?", args: [app.id] },
    ...rows.map((r) => ({
      sql: "INSERT INTO git_branch_rules (link_id, ref_pattern, branch_name, auto_switch, paused) VALUES (?, ?, ?, ?, ?)",
      args: [app.id, r.ref_pattern, r.branch_name, r.auto_switch === true ? 1 : 0, r.paused === true ? 1 : 0],
    })),
  ]);
  return (await rulesOf(c.deps, app.id)).map(ruleView);
}

/**
 * A person chose an older build, so git must not flip it again on the next push. Builds still land on their
 * targets; an admin resumes the flips.
 */
export async function pauseGitAutomation(deps: Pick<Deps, "storage">, orgId: string, appId: string): Promise<void> {
  const db = deps.storage.db;
  await db.batch([
    { sql: "UPDATE git_links SET paused = 1 WHERE app_id = ? AND org_id = ?", args: [appId, orgId] },
    { sql: "UPDATE git_branch_rules SET paused = 1 WHERE link_id = ? AND EXISTS (SELECT 1 FROM git_links WHERE app_id = ? AND org_id = ?)", args: [appId, appId, orgId] },
  ]);
}

/** Pauses when a promote lands on a version older than something git has deployed to this App. */
export async function pauseIfBehindGit(deps: Pick<Deps, "storage">, orgId: string, appId: string, version: number): Promise<void> {
  const row = await deps.storage.db.first<{ v: number | null }>(
    `SELECT max(d.version) AS v FROM git_deliveries d JOIN git_links l ON l.hook_id = d.hook_id
     WHERE l.app_id = ? AND l.org_id = ? AND d.target_id = ? AND d.deployed_at IS NOT NULL`,
    [appId, orgId, appId],
  );
  if (row?.v !== null && row?.v !== undefined && version < row.v) await pauseGitAutomation(deps, orgId, appId);
}
