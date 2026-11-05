import { hex, hmacSha256 } from "../../src/crypto/hash.ts";
import { HOUSEKEEPING_JOBS } from "../../src/jobs.ts";
import { runJobs } from "../../src/jobs/runner.ts";
import { APPS, createApp, world, type World } from "../apps/helpers.ts";
import type { Client } from "../auth/helpers.ts";
import type { Deps } from "../../src/app.ts";

export const TOKEN = "dev-insecure-git-read-token";
export const SHA_OLD = "a".repeat(40);
export const SHA_NEW = "b".repeat(40);
export const GIT = `${APPS}/hello/git`;

/** A provider that answers branch heads, repo metadata and commit statuses, and records every call. */
export class FakeGitHost {
  head = SHA_NEW;
  author = "Dev";
  fork = false;
  headStatus = 200;
  calls: { url: string; method: string; auth: string | null; redirect: string | undefined; body: unknown }[] = [];
  /** Host name → addresses the DNS-over-HTTPS lookup returns. */
  dns: Record<string, string[]> = { "github.com": ["140.82.112.3"], "gitea.example.com": ["93.184.216.34"], "gitlab.example.com": ["93.184.216.34"] };

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      const addrs = this.dns[u.searchParams.get("name") ?? ""] ?? [];
      const v6 = u.searchParams.get("type") === "AAAA";
      return Response.json({ Status: 0, Answer: addrs.filter((a) => a.includes(":") === v6).map((data) => ({ type: v6 ? 28 : 1, data })) });
    }
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? headers.get("private-token");
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    this.calls.push({ url, method: init?.method ?? "GET", auth, redirect: init?.redirect, body });
    if (init?.method === "POST") return Response.json({ id: 1 }, { status: 201 });
    if (u.pathname.includes("/branches/")) {
      if (this.headStatus !== 200) return Response.json({ message: "nope" }, { status: this.headStatus });
      return Response.json({
        name: "main",
        // GitHub's shape carries `sha` plus a nested commit; GitLab and Gitea carry `id` and `message`.
        commit: { sha: this.head, id: this.head, message: "fix: a thing\n\nbody", author_name: this.author, author: { name: this.author }, commit: { message: "fix: a thing\n\nbody", author: { name: this.author } } },
      });
    }
    return Response.json({ fork: this.fork });
  };

  statuses() {
    return this.calls.filter((c) => c.method === "POST");
  }
}

export interface GitWorld extends World {
  host: FakeGitHost;
  owner: Client;
  serviceId: string;
  /** Creates a link on the app `hello`; returns the once-shown secret and hook id. */
  link(over?: Record<string, unknown>): Promise<{ hook: string; secret: string }>;
  /** Signed push. */
  push(hook: string, secret: string, sha: string, over?: { ref?: string; delivery?: string; repo?: string; fork?: boolean; body?: string }): Promise<Response>;
  tick(): Promise<void>;
}

export async function gitWorld(over: Partial<Deps> = {}): Promise<GitWorld> {
  const host = new FakeGitHost();
  const w = await world({ fetch: host.fetch, ...over });
  const owner = await w.user("owner@example.com", "owner");
  await createApp(owner);
  const serviceId = [...w.fake.services.values()].find((s) => s.view.slug === "hello")?.view.id ?? "";
  const link: GitWorld["link"] = async (o = {}) => {
    const res = await owner.call("POST", GIT, {
      provider: "github", base_url: "https://github.com", repo: "acme/hello", branch: "main", token: TOKEN, ...o,
    });
    if (res.status !== 201) throw new Error(`link: ${res.status} ${await res.text()}`);
    const b = (await res.json()) as { hook_id: string; hook_secret: string };
    return { hook: b.hook_id, secret: b.hook_secret };
  };
  const push: GitWorld["push"] = async (hook, secret, sha, o = {}) => {
    const body = o.body ?? JSON.stringify({
      ref: o.ref ?? "refs/heads/main", after: sha, deleted: false,
      repository: { full_name: o.repo ?? "acme/hello", fork: o.fork === true },
    });
    const sig = hex(await hmacSha256(secret, new TextEncoder().encode(body)));
    return w.app.fetch(new Request(`http://localhost/api/hooks/git/${hook}`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": o.delivery ?? crypto.randomUUID(), "x-hub-signature-256": `sha256=${sig}` },
    }));
  };
  const tick = async () => {
    w.app.tick(120_000);
    await runJobs(w.app.deps, HOUSEKEEPING_JOBS.filter((j) => j.name === "git_deliveries"), { wallMs: 20_000, fetches: 50 });
  };
  return { ...w, host, owner, serviceId, link, push, tick };
}

export type DeliveryRow = { state: string; error: string | null; version: number | null; head_sha: string | null };

export const delivery = (w: World, sha: string) =>
  w.app.deps.storage.db.first<DeliveryRow>("SELECT state, error, version, head_sha FROM git_deliveries WHERE sha = ?", [sha]);
