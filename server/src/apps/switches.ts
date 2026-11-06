// Branches of an App and switching the App to one. Runtime answers pass through named fields only:
// a preflight compares env and secret names, and no other field of the runtime's answer reaches the
// browser. The body names a branch and nothing else, so a caller can never supply another service or a digest.

import { AppError, invalid, notFound } from "../http/errors.ts";
import { authorize } from "../orgs/members.ts";
import { isNotFound } from "../runtime/client.ts";
import { rt } from "../runtime/errors.ts";
import type * as T from "../runtime/types.ts";
import { BudgetExhausted } from "../jobs/budget.ts";
import { appFor, appUrl, quoteEtag, updateApp, type OrgCtx } from "./service.ts";
import { unpack } from "./source.ts";
import { renderTemplate, TEMPLATES } from "./templates.ts";

const BRANCH_RE = /^[a-z][a-z0-9-]{0,23}$/;
const SWITCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SWITCH_FIELDS = new Set(["branch", "dry_run", "close_sockets"]);
/** One runtime call per branch, within the task's fetch budget of 50. */
const MAX_BRANCH_DETAILS = 20;

export interface SwitchInput {
  branch: string;
  dry_run: boolean;
  close_sockets: boolean;
}

export function parseSwitch(b: Record<string, unknown>): SwitchInput {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!SWITCH_FIELDS.has(k)) fields[k] = "unknown";
  if (typeof b.branch !== "string" || !BRANCH_RE.test(b.branch)) fields.branch = "pattern";
  for (const k of ["dry_run", "close_sockets"]) {
    if (b[k] !== undefined && typeof b[k] !== "boolean") fields[k] = "not_boolean";
  }
  if (Object.keys(fields).length) throw invalid(fields);
  return { branch: b.branch as string, dry_run: b.dry_run === true, close_sockets: b.close_sockets === true };
}

function switchView(s: T.Switch) {
  return {
    id: s.id ?? null,
    kind: s.kind,
    state: s.state,
    from_version: s.from_version ?? null,
    to_version: s.to_version ?? null,
    source: s.source ? { version: s.source.version, digest: s.source.digest ?? null } : null,
    inflight_old: s.inflight_old,
    drain_deadline: s.drain_deadline ?? null,
    interrupted: s.interrupted,
    error: s.error ?? null,
    warnings: (s.warnings ?? []).map((w) => ({ code: w.code, names: w.names ?? [] })),
    pending_migrations: s.pending_migrations ?? null,
    dry_run: s.dry_run === true,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

export async function listBranches(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.read");
  // A grant covers one project, so nothing of another may be shown even if the runtime answered it.
  const items = (await rt(() => c.cli.listBranches(app.id))).filter((b) => b.project === app.project);
  return Promise.all(items.map(async (b, i) => {
    const versions = i < MAX_BRANCH_DETAILS ? await branchVersions(c, b.id) : [];
    const newest = versions.reduce<T.Version | null>((a, v) => (!a || v.version > a.version ? v : a), null);
    const shown = versions.find((v) => v.version === b.live_version) ?? newest;
    return {
      name: b.scratch?.name ?? b.slug.replace(`${slug}-br-`, ""),
      slug: b.slug,
      url: appUrl(c.deps.config.runtimePublicUrl, b.slug),
      build_state: newest?.build_state ?? b.status.build_state,
      live_version: b.live_version,
      digest: shown?.source_digest ?? null,
      expires_at: b.scratch?.expires_at ?? null,
      access: b.access,
    };
  }));
}

const BRANCH_FIELDS = new Set(["name", "copy_data", "parent_code", "expires_in_days", "access"]);
const MAX_BRANCH_DAYS = 365;

export interface BranchInput {
  name: string;
  copy_data: boolean;
  /** Start from the parent's live version. The default: an empty branch only offers the editor's starter. */
  parent_code: boolean;
  expires_in_days?: number;
  access?: "key" | "public";
}

export function parseBranch(b: Record<string, unknown>): BranchInput {
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!BRANCH_FIELDS.has(k)) fields[k] = "unknown";
  if (typeof b.name !== "string" || !BRANCH_RE.test(b.name) || b.name.includes("--")) fields.name = "pattern";
  if (b.copy_data !== undefined && typeof b.copy_data !== "boolean") fields.copy_data = "not_boolean";
  if (b.parent_code !== undefined && typeof b.parent_code !== "boolean") fields.parent_code = "not_boolean";
  const days = b.expires_in_days;
  if (days !== undefined && (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_BRANCH_DAYS)) fields.expires_in_days = "out_of_range";
  if (b.access !== undefined && b.access !== "key" && b.access !== "public") fields.access = "not_one_of";
  // The runtime forces key access on a copy of the data: a public one would publish it.
  if (b.copy_data === true && b.access === "public") fields.access = "not_one_of";
  if (Object.keys(fields).length) throw invalid(fields);
  return {
    name: b.name as string,
    copy_data: b.copy_data === true,
    parent_code: b.parent_code !== false,
    ...(days === undefined ? {} : { expires_in_days: days as number }),
    ...(b.access === undefined ? {} : { access: b.access as "key" | "public" }),
  };
}

export async function createBranch(c: OrgCtx, slug: string, input: BranchInput) {
  const app = await appFor(c, slug, "app.deploy");
  // Copied data can hold what this person may not read through the data browser.
  if (input.copy_data) authorize(c.sub, "app.data.export", app.project);
  const body = {
    name: input.name,
    ...(input.copy_data ? { copy_data: true } : {}),
    ...(input.parent_code ? { code_of_parent: true } : {}),
    ...(input.expires_in_days === undefined ? {} : { expires_at: c.deps.now() + input.expires_in_days * 86_400_000 }),
  };
  const b = await rt(() => c.cli.createBranch(app.id, body, crypto.randomUUID()));
  if (input.access && input.access !== b.access) {
    await updateApp(c, b.slug, { access: input.access } as T.ServicePatch, quoteEtag(b.etag));
  }
  return { name: input.name, slug: b.slug, url: appUrl(c.deps.config.runtimePublicUrl, b.slug) };
}

async function branchVersions(c: OrgCtx, id: string): Promise<T.Version[]> {
  try {
    return await c.cli.listVersions(id);
  } catch (e) {
    // Deleted between the two calls: the row still renders from the list.
    if (isNotFound(e)) return [];
    throw e;
  }
}

export async function switchTo(c: OrgCtx, slug: string, input: SwitchInput, etag: string) {
  const app = await appFor(c, slug, "app.deploy");
  if (!input.dry_run && !etag) throw new AppError(428, "precondition_required", "If-Match header required");
  const body = { from: { branch: input.branch }, close_sockets: input.close_sockets, dry_run: input.dry_run };
  const out = await rt(() => c.cli.switchTo(app.id, body, input.dry_run ? "" : etag));
  if (input.dry_run && (await holdsStarter(c, app.slug, input.branch, out))) {
    out.warnings = [...(out.warnings ?? []), { code: "replaces_with_starter" }];
  }
  return switchView(out);
}

/**
 * True when the source version is, byte for byte, a starter this console generates. Only a preflight's warning: a
 * source it cannot read says nothing about the switch. A parent with nothing live, or the same build, loses nothing.
 */
async function holdsStarter(c: OrgCtx, slug: string, branch: string, s: T.Switch): Promise<boolean> {
  if (!s.source || s.from_version === undefined) return false;
  const { service, version } = s.source;
  try {
    const src = await c.cli.versionSource(service, version);
    const body = typeof src.body === "string" ? src.body : JSON.stringify(src.body ?? "");
    const files = Object.values(unpack(body, src.contentType, src.encoding === "base64").files);
    if (files.length !== 1) return false;
    const code = files[0]?.trim();
    return Object.keys(TEMPLATES).some((t) =>
      [slug, `${slug}-br-${branch}`].some((owner) => renderTemplate(t, owner)?.trim() === code),
    );
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    return false;
  }
}

/**
 * Starts a promote and answers with its switch row. Skipping migrations leaves the data behind the code, and the
 * console's key may do it for anyone, so it takes the same right as exporting the data.
 */
export async function promoteAsync(c: OrgCtx, slug: string, b: { version: number; close_sockets?: boolean | undefined; migrate?: boolean | undefined }, etag: string) {
  const app = await appFor(c, slug, "app.deploy");
  if (b.migrate === false) authorize(c.sub, "app.data.export", app.project);
  if (!etag) throw new AppError(428, "precondition_required", "If-Match header required");
  const body = { version: b.version, ...(b.close_sockets === undefined ? {} : { close_sockets: b.close_sockets }), ...(b.migrate === undefined ? {} : { migrate: b.migrate }) };
  return switchView(await rt(() => c.cli.setLiveAsync(app.id, body, etag)));
}

export async function listSwitches(c: OrgCtx, slug: string, q: URLSearchParams) {
  const app = await appFor(c, slug, "app.read");
  const raw = q.get("limit");
  const limit = raw === null ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid({ limit: "out_of_range" });
  const cursor = q.get("cursor");
  const page = await rt(() => c.cli.listSwitches(app.id, cursor ? { limit, cursor } : { limit }));
  return { items: page.items.map(switchView), next_cursor: page.next_cursor ?? null };
}

export async function getSwitch(c: OrgCtx, slug: string, id: string) {
  const app = await appFor(c, slug, "app.read");
  if (!SWITCH_ID_RE.test(id)) throw notFound();
  return switchView(await rt(() => c.cli.getSwitch(app.id, id)));
}

export async function rollback(c: OrgCtx, slug: string, id: string, etag: string) {
  const app = await appFor(c, slug, "app.deploy");
  if (!SWITCH_ID_RE.test(id)) throw notFound();
  if (!etag) throw new AppError(428, "precondition_required", "If-Match header required");
  return switchView(await rt(() => c.cli.rollbackSwitch(app.id, id, etag)));
}
