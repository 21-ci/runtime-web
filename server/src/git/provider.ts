// What the console says to a Git host: which URL, which credential header, and how to read the answer.
// Every call refuses redirects, because the guard strips only some credential headers on a hop and a
// redirect from a self-hosted instance could otherwise carry the token elsewhere.

import { isPrivateHost } from "../auth/oauth.ts";
import type { WebhookProvider } from "../hooks/verify.ts";
import { rethrowBudget } from "../jobs/budget.ts";

export type Provider = WebhookProvider;
export const PROVIDERS: readonly Provider[] = ["github", "gitlab", "gitea"];

export interface Repo {
  provider: Provider;
  base_url: string;
  repo: string;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_ANSWER_BYTES = 256 * 1024;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const isSha = (v: unknown): v is string => typeof v === "string" && SHA_RE.test(v);

/** A trailing dot names the same host, and would slip past the name checks. */
export const publicLiteral = (hostname: string) => !isPrivateHost(hostname.replace(/\.+$/, ""));

/** The canonical origin of a base URL, or null: https, no credentials, path, query or fragment, not private as written. */
export function parseBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 255) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || raw.includes("#") || raw.includes("?")) return null;
  if (u.pathname !== "/" || !u.hostname || !publicLiteral(u.hostname)) return null;
  return u.origin;
}

const REPO_SEG = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function validRepo(provider: Provider, repo: unknown): repo is string {
  if (typeof repo !== "string" || repo.length > 255) return false;
  const segs = repo.split("/");
  if (!segs.every((s) => REPO_SEG.test(s))) return false;
  return provider === "gitlab" ? segs.length >= 2 : segs.length === 2;
}

export function validBranch(b: unknown): b is string {
  return typeof b === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(b) && !b.includes("..") && !b.includes("//") && !b.startsWith("/") && !b.endsWith("/") && !b.startsWith("-");
}

export function validSubdir(s: unknown): s is string {
  return typeof s === "string" && s.length <= 255 && s.split("/").every((p) => /^[A-Za-z0-9_.-]+$/.test(p) && p !== "." && p !== "..");
}

function api(r: Repo): string {
  switch (r.provider) {
    case "github":
      return new URL(r.base_url).hostname === "github.com" ? "https://api.github.com" : `${r.base_url}/api/v3`;
    case "gitlab":
      return `${r.base_url}/api/v4`;
    case "gitea":
      return `${r.base_url}/api/v1`;
  }
}

const repoPath = (r: Repo) => (r.provider === "gitlab" ? `/projects/${encodeURIComponent(r.repo)}` : `/repos/${r.repo}`);

export function archiveUrl(r: Repo, sha: string): string {
  const base = `${api(r)}${repoPath(r)}`;
  switch (r.provider) {
    case "github":
      return `${base}/tarball/${sha}`;
    case "gitlab":
      return `${base}/repository/archive.tar.gz?sha=${sha}`;
    case "gitea":
      return `${base}/archive/${sha}.tar.gz`;
  }
}

export function authHeaders(provider: Provider, token: string | null): Record<string, string> | undefined {
  if (!token) return undefined;
  switch (provider) {
    case "github":
      return { authorization: `Bearer ${token}` };
    case "gitlab":
      return { "private-token": token };
    case "gitea":
      return { authorization: `token ${token}` };
  }
}

/** Returns the answer, or null for a network failure. The cap holds against a self-hosted server sending without end. */
async function call(f: typeof fetch, url: string, token: string | null, r: Repo, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: unknown } | null> {
  if (!publicLiteral(new URL(url).hostname)) return null;
  try {
    const res = await f(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json", ...authHeaders(r.provider, token), ...(init.headers as Record<string, string> | undefined) },
    });
    const raw = res.body ? await readCapped(res.body, MAX_ANSWER_BYTES) : new Uint8Array();
    let body: unknown = null;
    if (raw) {
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        body = null;
      }
    }
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    rethrowBudget(e);
    return null;
  }
}

/** The whole stream, or null past max bytes. */
export async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export type HeadResult =
  | { kind: "head"; sha: string; author: string; message: string }
  /** The host refused to say: a bad token, a private repo without one, or no such branch. */
  | { kind: "denied" }
  /** Try again later: an outage, a rate limit or an answer that makes no sense. */
  | { kind: "retry" };

// Commit text is someone else's input. It is only rendered as text and goes in a 4 KiB meta field.
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return (v.split("\n")[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

interface BranchAnswer {
  commit?: {
    sha?: unknown;
    id?: unknown;
    message?: unknown;
    author_name?: unknown;
    author?: { name?: unknown };
    commit?: { message?: unknown; author?: { name?: unknown } };
  };
}

export async function fetchHead(f: typeof fetch, r: Repo, branch: string, token: string | null): Promise<HeadResult> {
  const path = r.provider === "gitlab" ? "/repository/branches/" : "/branches/";
  const res = await call(f, `${api(r)}${repoPath(r)}${path}${encodeURIComponent(branch)}`, token, r);
  if (!res || res.status === 429 || res.status >= 500) return { kind: "retry" };
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // GitHub answers an exhausted rate limit with 403.
    return res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") ? { kind: "retry" } : { kind: "denied" };
  }
  const c = (res.body as BranchAnswer | null)?.commit;
  const sha = r.provider === "github" ? c?.sha : c?.id;
  if (res.status !== 200 || !isSha(sha)) return { kind: "retry" };
  return {
    kind: "head",
    sha,
    author: clean(c?.commit?.author?.name ?? c?.author_name ?? c?.author?.name, 100),
    message: clean(c?.commit?.message ?? c?.message, 200),
  };
}

/** True only when the host itself says the repo is not a fork. A hook body proves nothing on GitLab, so this decides. */
export async function confirmedNotFork(f: typeof fetch, r: Repo, token: string | null): Promise<boolean> {
  const res = await call(f, `${api(r)}${repoPath(r)}`, token, r);
  if (!res || res.status !== 200 || res.body === null || typeof res.body !== "object") return false;
  const b = res.body as { fork?: unknown; forked_from_project?: unknown };
  return b.fork !== true && !b.forked_from_project;
}

export type CommitState = "pending" | "success" | "failure";

/** Best effort: a read-only token gets 403 here, and a deploy must not depend on it. */
export async function postStatus(f: typeof fetch, r: Repo, sha: string, token: string, state: CommitState, targetUrl: string | null): Promise<void> {
  const description = { pending: "Building", success: "Deployed", failure: "Deploy failed" }[state];
  const body = r.provider === "gitlab"
    ? { state: state === "failure" ? "failed" : state, name: "21cloud/deploy", description, ...(targetUrl ? { target_url: targetUrl } : {}) }
    : { state, context: "21cloud/deploy", description, ...(targetUrl ? { target_url: targetUrl } : {}) };
  await call(f, `${api(r)}${repoPath(r)}/statuses/${sha}`, token, r, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

export interface Push {
  ref: string;
  branch: string;
  sha: string;
  fork: boolean;
}

interface PushBody {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { full_name?: unknown; fork?: unknown };
  project?: { path_with_namespace?: unknown };
}

const EVENT_HEADER: Record<Provider, [string, string]> = {
  github: ["x-github-event", "push"],
  gitea: ["x-gitea-event", "push"],
  gitlab: ["x-gitlab-event", "Push Hook"],
};
const DELIVERY_HEADER: Record<Provider, string> = { github: "x-github-delivery", gitea: "x-gitea-delivery", gitlab: "x-gitlab-event-uuid" };

/** Unsigned on every provider, so it is only ever kept as a label. */
export function deliveryId(provider: Provider, headers: Headers): string | null {
  const v = headers.get(DELIVERY_HEADER[provider]);
  return v && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
}

/** The push this body describes, or null when there is nothing to deploy from it. */
export function parsePush(r: Repo, headers: Headers, raw: Uint8Array): Push | null {
  const [name, want] = EVENT_HEADER[r.provider];
  if (headers.get(name) !== want) return null;
  let b: PushBody | null;
  try {
    b = JSON.parse(new TextDecoder().decode(raw)) as PushBody | null;
  } catch {
    return null;
  }
  if (b === null || typeof b !== "object") return null;
  if (typeof b.ref !== "string" || b.ref.length > 255 || !b.ref.startsWith("refs/heads/")) return null;
  const branch = b.ref.slice("refs/heads/".length);
  if (!validBranch(branch) || !isSha(b.after) || /^0+$/.test(b.after) || b.deleted === true) return null;
  const name2 = r.provider === "gitlab" ? b.project?.path_with_namespace : b.repository?.full_name;
  // A fork's own hook, or a body copied from one: refs of another repository are never deployed.
  if (typeof name2 !== "string" || name2.toLowerCase() !== r.repo.toLowerCase()) return null;
  return { ref: b.ref, branch, sha: b.after, fork: b.repository?.fork === true };
}

export interface PullEvent {
  action: "open" | "close";
  pr: number;
  sha: string;
  /** The base repository's numeric id. Null when the body has none: such an event deploys nothing. */
  repoId: number | null;
  headRepoId: number | null;
  /** Fail closed: anything but two equal numeric ids is a fork. */
  fork: boolean;
}

const PULL_EVENTS: Record<Provider, readonly string[]> = {
  github: ["pull_request"],
  gitea: ["pull_request", "pull_request_sync"],
  gitlab: ["Merge Request Hook"],
};
const PULL_OPEN = new Set(["opened", "reopened", "synchronize", "synchronized"]);
const PULL_CLOSE = new Set(["closed"]);
const numericId = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const isFork = (base: number | null, head: number | null) => base === null || head === null || base !== head;

interface PullBody {
  action?: unknown;
  number?: unknown;
  repository?: { id?: unknown; full_name?: unknown };
  pull_request?: { number?: unknown; head?: { sha?: unknown; repo?: { id?: unknown } | null }; base?: { repo?: { id?: unknown } | null } };
  project?: { id?: unknown; path_with_namespace?: unknown };
  object_attributes?: { iid?: unknown; action?: unknown; oldrev?: unknown; source_project_id?: unknown; target_project_id?: unknown; last_commit?: { id?: unknown } };
}

/** The pull or merge request event this body describes, or null when there is nothing to do for it. */
export function parsePull(r: Repo, headers: Headers, raw: Uint8Array): PullEvent | null {
  const event = headers.get(EVENT_HEADER[r.provider][0]);
  if (!event || !PULL_EVENTS[r.provider].includes(event)) return null;
  let b: PullBody | null;
  try {
    b = JSON.parse(new TextDecoder().decode(raw)) as PullBody | null;
  } catch {
    return null;
  }
  if (b === null || typeof b !== "object") return null;
  const gitlab = r.provider === "gitlab";
  const name = gitlab ? b.project?.path_with_namespace : b.repository?.full_name;
  if (typeof name !== "string" || name.toLowerCase() !== r.repo.toLowerCase()) return null;

  let action: PullEvent["action"];
  let pr: unknown;
  let sha: unknown;
  let repoId: number | null;
  let headRepoId: number | null;
  if (gitlab) {
    const o = b.object_attributes;
    const a = o?.action;
    if (a === "close" || a === "merge") action = "close";
    // An update without oldrev edits the title or labels, and changes no code.
    else if (a === "open" || a === "reopen" || (a === "update" && typeof o?.oldrev === "string")) action = "open";
    else return null;
    pr = o?.iid;
    sha = o?.last_commit?.id;
    repoId = numericId(o?.target_project_id);
    headRepoId = numericId(o?.source_project_id);
  } else {
    if (typeof b.action !== "string") return null;
    if (PULL_CLOSE.has(b.action)) action = "close";
    else if (PULL_OPEN.has(b.action)) action = "open";
    else return null;
    pr = b.number ?? b.pull_request?.number;
    sha = b.pull_request?.head?.sha;
    repoId = numericId(b.pull_request?.base?.repo?.id) ?? numericId(b.repository?.id);
    headRepoId = numericId(b.pull_request?.head?.repo?.id);
  }
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr < 1 || !isSha(sha)) return null;
  return { action, pr, sha, repoId, headRepoId, fork: isFork(repoId, headRepoId) };
}

export type PullHead =
  | { kind: "head"; sha: string; open: boolean; author: string; message: string; fork: boolean }
  | { kind: "denied" }
  | { kind: "retry" };

interface PullAnswer {
  state?: unknown;
  sha?: unknown;
  title?: unknown;
  user?: { login?: unknown };
  author?: { username?: unknown };
  source_project_id?: unknown;
  target_project_id?: unknown;
  head?: { sha?: unknown; repo?: { id?: unknown } | null };
  base?: { repo?: { id?: unknown } | null };
}

/** The host's own word on a request's head and origin: a webhook only says "go and look", as for a push. */
export async function fetchPullHead(f: typeof fetch, r: Repo, pr: number, token: string | null): Promise<PullHead> {
  const path = r.provider === "gitlab" ? `/merge_requests/${pr}` : `/pulls/${pr}`;
  const res = await call(f, `${api(r)}${repoPath(r)}${path}`, token, r);
  if (!res || res.status === 429 || res.status >= 500) return { kind: "retry" };
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") ? { kind: "retry" } : { kind: "denied" };
  }
  const b = res.body as PullAnswer | null;
  const gitlab = r.provider === "gitlab";
  const sha = gitlab ? b?.sha : b?.head?.sha;
  if (res.status !== 200 || !isSha(sha)) return { kind: "retry" };
  const base = numericId(gitlab ? b?.target_project_id : b?.base?.repo?.id);
  const head = numericId(gitlab ? b?.source_project_id : b?.head?.repo?.id);
  return {
    kind: "head",
    sha,
    open: gitlab ? b?.state === "opened" : b?.state === "open",
    author: clean(gitlab ? b?.author?.username : b?.user?.login, 100),
    message: clean(b?.title, 200),
    fork: isFork(base, head),
  };
}

/** `*` stays inside one path segment, `**` crosses them. Input lengths are capped, so this stays cheap. */
export function globMatch(pattern: string, branch: string): boolean {
  const re = pattern.split(/(\*\*?)/).map((p) => (p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`).test(branch);
}

export function validPattern(p: unknown): p is string {
  return typeof p === "string" && /^[A-Za-z0-9._/*-]{1,200}$/.test(p) && !p.includes("..") && (p.match(/\*/g)?.length ?? 0) <= 4;
}
