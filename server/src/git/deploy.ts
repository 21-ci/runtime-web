// POST …/deploys, for CI that builds its own archive. The caller already holds deploy rights and names a
// URL it chose, so no stored credential ever goes with it; the runtime fetches through the egress guard.

import { appFor, type OrgCtx } from "../apps/service.ts";
import { AppError, invalid } from "../http/errors.ts";
import { rt } from "../runtime/errors.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { isSha, publicLiteral, validBranch } from "./provider.ts";
import { BRANCH_NAME_RE } from "./links.ts";

const FIELDS = new Set(["url", "sha", "ref", "branch"]);
const MAX_URL = 2048;

function parseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && publicLiteral(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

export async function deploy(c: OrgCtx, slug: string, b: Record<string, unknown>) {
  const app = await appFor(c, slug, "app.deploy");
  const fields: Record<string, string> = {};
  for (const k of Object.keys(b)) if (!FIELDS.has(k)) fields[k] = "unknown";
  const url = parseUrl(b.url);
  if (!url) fields.url = "not_public_https";
  if (b.sha !== undefined && !isSha(b.sha)) fields.sha = "pattern";
  if (b.ref !== undefined && !(typeof b.ref === "string" && b.ref.startsWith("refs/") && validBranch(b.ref.slice(5)))) fields.ref = "pattern";
  if (b.branch !== undefined && !(typeof b.branch === "string" && BRANCH_NAME_RE.test(b.branch))) fields.branch = "pattern";
  if (Object.keys(fields).length) throw invalid(fields);

  let target = app.id;
  if (typeof b.branch === "string") {
    const found = (await rt(() => c.cli.listBranches(app.id))).find((x) => x.scratch?.name === b.branch && x.project === app.project);
    if (!found) throw new AppError(404, "not_found", "not found");
    target = found.id;
  }
  const meta = typeof b.sha === "string" ? { git: { sha: b.sha, ...(typeof b.ref === "string" ? { ref: b.ref } : {}) } } : undefined;
  // The signed query of a release URL is a credential: it stays out of the key as it does out of the audit.
  const idem = await sha256Hex(`${target}|${url?.origin}${url?.pathname}|${String(b.sha ?? c.deps.now())}`);
  const body = { url: String(b.url), strip_components: 1, compile: "eager" as const, activate: "after_build" as const, ...(meta ? { meta } : {}) };
  // A failed fetch shows later on the version (build_state failed, failure.code): this only starts it.
  const v = await rt(() => c.cli.fromUrl(target, body, idem));
  return { version: v.version, build_state: v.build_state, host: url?.host ?? "", target };
}
