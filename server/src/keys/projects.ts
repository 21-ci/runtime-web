// Projects of an org (port of internal/apps/projects.go). The runtime owns the
// projects; calls go through the org's default key so the relay enforces the
// tenant. Members see only projects they hold a grant on.

import type { Deps } from "../app.ts";
import { dbOf } from "../auth/types.ts";
import { conflict, forbidden, invalid, notFound } from "../http/errors.ts";
import { isNotFound, isRuntimeError, type Scoped } from "../runtime/client.ts";
import type { Project as RtProject } from "../runtime/types.ts";
import type { OrgRow, Subject } from "./access.ts";
import { canOrg, grantRoles, isOrgAdmin, projectRole } from "./access.ts";
import { defaultKeySecret, rtOf } from "./keys.ts";

export interface ProjectJson {
  slug: string;
  name: string;
  environments: string[];
  created_at: number;
  updated_at: number;
  role: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function projectFrom(sub: Subject, grants: Map<string, string>, p: RtProject): ProjectJson {
  const role = isOrgAdmin(sub) ? "admin" : (grants.get(p.slug) ?? "");
  return {
    slug: p.slug,
    name: p.name,
    environments: p.environments,
    created_at: p.created_at,
    updated_at: p.updated_at,
    role,
  };
}

/** Maps a runtime failure to the org error model. Unknown runtime errors propagate. */
function mapRuntime(e: unknown, on409: (code: string) => string): never {
  if (isNotFound(e)) throw notFound();
  if (isRuntimeError(e)) {
    if (e.status === 409) throw conflict(on409(e.code), e.message);
    if (e.status === 400 || e.status === 422) throw invalid({ body: e.message });
  }
  throw e;
}

const slugTaken = (code: string) => (code === "project_slug_taken" || code.includes("slug") ? "slug_taken" : code);

async function scopedClient(deps: Deps, org: OrgRow): Promise<Scoped> {
  return rtOf(deps).as(await defaultKeySecret(deps, org));
}

/** Projects the caller may read (all for owners/admins, granted ones for members). */
export async function listProjects(deps: Deps, org: OrgRow, sub: Subject): Promise<ProjectJson[]> {
  const cli = await scopedClient(deps, org);
  const grants = await grantRoles(await dbOf(deps), org.id, sub.userId);
  const out: ProjectJson[] = [];
  let cursor: string | undefined;
  do {
    const page = await cli.listProjects(cursor);
    for (const p of page.items) {
      if (isOrgAdmin(sub) || grants.has(p.slug)) out.push(projectFrom(sub, grants, p));
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

async function readable(deps: Deps, org: OrgRow, sub: Subject, slug: string): Promise<void> {
  if (!(await projectRole(await dbOf(deps), sub, org.id, slug))) throw notFound();
}

export async function getProject(deps: Deps, org: OrgRow, sub: Subject, slug: string): Promise<ProjectJson> {
  await readable(deps, org, sub, slug);
  const cli = await scopedClient(deps, org);
  try {
    const p = await cli.getProject(slug);
    return projectFrom(sub, await grantRoles(await dbOf(deps), org.id, sub.userId), p);
  } catch (e) {
    mapRuntime(e, slugTaken);
  }
}

export async function environments(deps: Deps, org: OrgRow, sub: Subject, slug: string): Promise<string[]> {
  await readable(deps, org, sub, slug);
  const cli = await scopedClient(deps, org);
  try {
    const { environments: envs } = await cli.getProjectEnvironments(slug);
    // Some runtime builds report {name} objects; the API carries names only.
    return envs.map((e) => (typeof e === "string" ? e : (e as { name: string }).name));
  } catch (e) {
    mapRuntime(e, slugTaken);
  }
}

export interface ProjectCreateReq {
  slug: string;
  name?: string;
  environments?: string[];
}

export function parseCreate(body: unknown): ProjectCreateReq {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errs: Record<string, string> = {};
  if (typeof b.slug !== "string" || !SLUG.test(b.slug)) errs.slug = "lowercase letters, digits and dashes";
  if (b.name !== undefined && typeof b.name !== "string") errs.name = "must be a string";
  if (b.environments !== undefined && (!Array.isArray(b.environments) || b.environments.some((e) => typeof e !== "string" || !e.trim()))) {
    errs.environments = "must be a list of names";
  }
  if (Object.keys(errs).length) throw invalid(errs);
  return {
    slug: b.slug as string,
    ...(b.name !== undefined ? { name: b.name as string } : {}),
    ...(b.environments !== undefined ? { environments: (b.environments as string[]).map((e) => e.trim()) } : {}),
  };
}

export async function createProject(deps: Deps, org: OrgRow, sub: Subject, req: ProjectCreateReq): Promise<ProjectJson> {
  if (!canOrg(sub, "project.create")) throw forbidden("forbidden", "not allowed");
  const cli = await scopedClient(deps, org);
  let p: RtProject;
  try {
    p = await cli.createProject({ slug: req.slug, ...(req.name ? { name: req.name } : {}), ...(req.environments ? { environments: req.environments } : {}) });
  } catch (e) {
    mapRuntime(e, slugTaken);
  }
  // Grants left by a failed delete must not re-activate on slug reuse.
  const db = await dbOf(deps);
  await db.run("DELETE FROM project_grants WHERE org_id = ? AND project = ?", [org.id, req.slug]);
  return projectFrom(sub, new Map(), p);
}

export interface ProjectPatchReq {
  name?: string;
  environments?: string[];
}

export function parsePatch(body: unknown): ProjectPatchReq {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const errs: Record<string, string> = {};
  if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim())) errs.name = "must be a non-empty string";
  if (b.environments !== undefined && (!Array.isArray(b.environments) || b.environments.some((e) => typeof e !== "string" || !e.trim()))) {
    errs.environments = "must be a list of names (complete new list)";
  }
  if (Object.keys(errs).length) throw invalid(errs);
  return {
    ...(b.name !== undefined ? { name: (b.name as string).trim() } : {}),
    ...(b.environments !== undefined ? { environments: (b.environments as string[]).map((e) => e.trim()) } : {}),
  };
}

export async function updateProject(deps: Deps, org: OrgRow, sub: Subject, slug: string, req: ProjectPatchReq): Promise<ProjectJson> {
  const role = await projectRole(await dbOf(deps), sub, org.id, slug);
  if (!role) throw notFound();
  if (role !== "admin") throw forbidden("forbidden", "not allowed");
  const cli = await scopedClient(deps, org);
  try {
    const p = await cli.updateProject(slug, req);
    return projectFrom(sub, await grantRoles(await dbOf(deps), org.id, sub.userId), p);
  } catch (e) {
    mapRuntime(e, slugTaken);
  }
}

export async function deleteProject(deps: Deps, org: OrgRow, sub: Subject, slug: string): Promise<void> {
  if (!canOrg(sub, "project.delete")) {
    if (!(await projectRole(await dbOf(deps), sub, org.id, slug))) throw notFound();
    throw forbidden("forbidden", "not allowed");
  }
  const cli = await scopedClient(deps, org);
  try {
    await cli.deleteProject(slug);
  } catch (e) {
    mapRuntime(e, (code) => (code === "project_not_empty" ? code : slugTaken(code)));
  }
  const db = await dbOf(deps);
  await db.run("DELETE FROM project_grants WHERE org_id = ? AND project = ?", [org.id, slug]);
}
