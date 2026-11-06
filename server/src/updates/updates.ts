// Tells instance admins when a newer release exists. The check only reads GitHub's release list: the console is a
// sandboxed App with no access to the host, so it never installs anything. The upgrade is commands an admin runs,
// where install.sh verifies what it downloads.

import type { Deps } from "../app.ts";
import { readCapped } from "../git/provider.ts";
import { BudgetExhausted } from "../jobs/budget.ts";
import type { Job } from "../jobs/runner.ts";
import { runtimeVersion } from "../keys/node.ts";
import type { Db } from "../storage/types.ts";

const SIX_HOURS_MS = 6 * 3_600_000;
const CHECK_NOW_MIN_AGE_MS = 60_000;
const SETTING_ENABLED = "updates.enabled";
const SETTING_STATE = "updates.state";
const MAX_BODY_BYTES = 4_000_000;
const MAX_ETAG_CHARS = 256;
const UPSERT = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

// Same repositories as install.sh (REPO, RT_REPO).
const RTWEB_REPO = "21-ci/runtime-web";
const RT_REPO = "21-ci/runtime";
const REPOS = [RT_REPO, RTWEB_REPO] as const;

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// The version from a tag is pasted into a root shell by an admin, so only digits and dots get through.
const STABLE_TAG = /^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/;

function parse(v: string): { core: [number, number, number]; pre: boolean } | null {
  const m = VERSION.exec(v);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: v.replace(/\+.*$/, "").includes("-") };
}

/** Negative, zero or positive like a sort comparator; null when either side is not a version ("dev"). */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (const i of [0, 1, 2] as const) {
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  }
  return Number(y.pre) - Number(x.pre);
}

export interface LatestRelease {
  version: string;
  tag: string;
}

/** The highest stable release. GitHub's own "latest" follows creation date, so a backport would win there. */
export function pickLatest(releases: unknown[]): LatestRelease | null {
  let best: LatestRelease | null = null;
  for (const r of releases) {
    const { tag_name: tag, draft, prerelease } = (r ?? {}) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (typeof tag !== "string" || draft === true || prerelease === true || !STABLE_TAG.test(tag)) continue;
    const version = tag.replace(/^v/, "");
    if (!best || (compareVersions(version, best.version) ?? 0) > 0) best = { version, tag };
  }
  return best;
}

interface RepoState {
  checked_at: number;
  etag?: string;
  latest?: LatestRelease;
  failed?: boolean;
  /** Why it failed: `http_<status>`, `network` or `bad_response`. Never text from the response. */
  error?: string;
}
type State = Record<string, RepoState>;

async function readSetting(db: Db, key: string): Promise<string | null> {
  return (await db.first<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]))?.value ?? null;
}

async function readState(db: Db): Promise<State> {
  const raw = await readSetting(db, SETTING_STATE);
  return raw ? (JSON.parse(raw) as State) : {};
}

export async function checksEnabled(db: Db): Promise<boolean> {
  return (await readSetting(db, SETTING_ENABLED)) !== "false";
}

/** What one fetch adds to the repository's state; a failure keeps the last known version. */
async function checkRepo(f: typeof fetch, repo: string, prev: RepoState | undefined): Promise<Omit<RepoState, "checked_at">> {
  const kept = { ...(prev?.etag ? { etag: prev.etag } : {}), ...(prev?.latest ? { latest: prev.latest } : {}) };
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "runtime-web",
    "x-github-api-version": "2022-11-28",
  };
  if (prev?.etag) headers["if-none-match"] = prev.etag;
  try {
    const res = await f(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers });
    if (res.status === 304) return kept;
    if (!res.ok) return { ...kept, failed: true, error: `http_${res.status}` };
    const raw = res.body ? await readCapped(res.body, MAX_BODY_BYTES) : null;
    const list = raw ? (JSON.parse(new TextDecoder().decode(raw)) as unknown) : null;
    if (!Array.isArray(list)) return { ...kept, failed: true, error: "bad_response" };
    const latest = pickLatest(list);
    const etag = res.headers.get("etag");
    return {
      ...(etag && etag.length <= MAX_ETAG_CHARS ? { etag } : {}),
      ...(latest ? { latest } : {}),
    };
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    return { ...kept, failed: true, error: "network" };
  }
}

async function checkRepos(deps: { storage: Deps["storage"]; now: () => number }, f: typeof fetch, minAgeMs: number): Promise<void> {
  const db = deps.storage.db;
  if (!(await checksEnabled(db))) return;
  const state = await readState(db);
  for (const repo of REPOS) {
    const prev = state[repo];
    // The runner retries a failed job sooner than everyMs; the limit toward GitHub holds regardless.
    if (prev && deps.now() - prev.checked_at < minAgeMs) continue;
    const next = await checkRepo(f, repo, prev);
    state[repo] = { checked_at: deps.now(), ...next };
    await db.run(UPSERT, [SETTING_STATE, JSON.stringify(state)]);
  }
}

export const UPDATE_CHECK_JOB: Job = {
  name: "update_check",
  everyMs: SIX_HOURS_MS,
  run: async ({ deps }) => {
    await checkRepos(deps, deps.fetch, SIX_HOURS_MS);
  },
};

/** "Check now". GitHub's anonymous limit is per address, so repeated clicks within a minute reuse the last answer. */
export const checkNow = (deps: Deps) => checkRepos(deps, deps.fetch ?? globalThis.fetch, CHECK_NOW_MIN_AGE_MS);

function installerCommand(v: string, host: string, docker: boolean): string {
  return [
    `curl -fsSL https://raw.githubusercontent.com/${RTWEB_REPO}/v${v}/install.sh -o install.sh`,
    `sudo sh install.sh --yes${docker ? " --mode docker" : ""} --version ${v} --domain ${host} --email you@your-company.com`,
  ].join("\n");
}

/** The installer's own path for a bare node: it verifies the release as a first install does, then restarts rt. */
function runtimeCommand(v: string, installer: string): string {
  // `installer` is always a release tag: this script runs as root, so never from a moving branch.
  return [
    `curl -fsSL https://raw.githubusercontent.com/${RTWEB_REPO}/${installer}/install.sh -o install.sh`,
    `sudo sh install.sh --upgrade-runtime --runtime-version ${v}`,
  ].join("\n");
}

async function currentRuntime(deps: Deps): Promise<string | null> {
  try {
    return (await runtimeVersion(deps)).version;
  } catch {
    return null; // A node that does not answer must not break the sidebar.
  }
}

export async function updatesView(deps: Deps) {
  const db = deps.storage.db;
  const enabled = await checksEnabled(db);
  const state = await readState(db);
  const host = new URL(deps.config.origin).hostname;
  const item = (component: "runtime" | "runtime_web", repo: string, current: string | null) => {
    const s = state[repo];
    const latest = s?.latest ?? null;
    const web = component === "runtime_web";
    const installerTag = state[RTWEB_REPO]?.latest?.tag;
    return {
      component,
      repo,
      current,
      latest: latest?.version ?? null,
      outdated: enabled && !!latest && !!current && (compareVersions(latest.version, current) ?? 0) > 0,
      check_failed: s?.failed === true,
      check_error: s?.failed === true ? (s.error ?? "unknown") : null,
      notes_url: latest ? `https://github.com/${repo}/releases/tag/${latest.tag}` : null,
      commands: !latest
        ? null
        : web
          ? { bare: installerCommand(latest.version, host, false), docker: installerCommand(latest.version, host, true) }
          : installerTag // No pinned installer known yet: no command, rather than one from a branch.
            ? { bare: runtimeCommand(latest.version, installerTag), docker: null } // The image bundles rt.
            : null,
    };
  };
  const times = REPOS.map((r) => state[r]?.checked_at ?? 0);
  return {
    enabled,
    checked_at: Math.max(...times) || null,
    items: [item("runtime_web", RTWEB_REPO, deps.version), item("runtime", RT_REPO, await currentRuntime(deps))],
  };
}

/** The statements that flip the toggle; turning it on makes the job due on the next tick. */
export function setEnabledStmts(enabled: boolean) {
  return [
    { sql: UPSERT, args: [SETTING_ENABLED, String(enabled)] },
    { sql: "UPDATE job_state SET next_at = 0 WHERE name = ?", args: [UPDATE_CHECK_JOB.name] },
  ];
}
