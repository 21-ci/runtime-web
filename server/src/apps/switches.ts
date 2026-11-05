// Branches of an App and switching the App to one. Runtime answers pass through named fields only:
// a preflight compares env and secret names, and no other field of the runtime's answer reaches the
// browser. The body names a branch and nothing else, so a caller can never supply another service or a digest.

import { AppError, invalid, notFound } from "../http/errors.ts";
import { authorize } from "../orgs/members.ts";
import { isNotFound } from "../runtime/client.ts";
import { rt } from "../runtime/errors.ts";
import type * as T from "../runtime/types.ts";
import { appFor, appUrl, type OrgCtx } from "./service.ts";

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
    };
  }));
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
  return switchView(await rt(() => c.cli.switchTo(app.id, body, input.dry_run ? "" : etag)));
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
