import { AppError } from "./errors.ts";
import { runtimeAppError } from "../runtime/errors.ts";
import { errorResponse, json } from "./json.ts";

// Minimal method + path router. Patterns use `:name` segments ("/api/orgs/:org").
// Feature modules register through `Router.add`; middleware wraps the handler.

export type Params = Record<string, string>;

export interface RequestContext {
  req: Request;
  url: URL;
  params: Params;
  /** Path the browser sees in front of ours: "/s/<slug>" on path routes, "" on hosts. */
  basePath: string;
  clientIp: string | undefined;
  /** Filled by auth middleware (task: auth-sessions). */
  state: Record<string, unknown>;
}

export type Handler = (ctx: RequestContext) => Response | Promise<Response>;
export type Middleware = (ctx: RequestContext, next: () => Promise<Response>) => Promise<Response>;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: Handler;
}

export interface RouteInfo {
  method: string;
  pattern: string;
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly middleware: Middleware[] = [];
  private fallback: Handler | undefined;

  use(mw: Middleware): this {
    this.middleware.push(mw);
    return this;
  }

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, segments: split(pattern), handler });
    return this;
  }

  /** Registered routes, for the contract guard (test/contract.test.ts). */
  describe(): RouteInfo[] {
    return this.routes.map((r) => ({ method: r.method, pattern: `/${r.segments.join("/")}` }));
  }

  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  /** Handler for paths no route matches (the SPA). */
  notFound(h: Handler): this {
    this.fallback = h;
    return this;
  }

  async handle(req: Request, base: Omit<RequestContext, "req" | "url" | "params" | "state">): Promise<Response> {
    const url = new URL(req.url);
    const ctx: RequestContext = { req, url, params: {}, state: {}, ...base };
    try {
      const run = async () => this.dispatch(ctx);
      const chain = this.middleware.reduceRight<() => Promise<Response>>(
        (next, mw) => () => mw(ctx, next),
        run,
      );
      return await chain();
    } catch (err) {
      if (err instanceof AppError) return errorResponse(err);
      const mapped = runtimeAppError(err);
      if (mapped) return errorResponse(mapped);
      console.error("unhandled", err instanceof Error ? err.stack ?? err.message : String(err));
      return json({ error: { code: "internal", message: "internal error" } }, 500);
    }
  }

  private async dispatch(ctx: RequestContext): Promise<Response> {
    const path = split(ctx.url.pathname);
    let pathMatched = false;
    for (const r of this.routes) {
      const params = match(r.segments, path);
      if (!params) continue;
      pathMatched = true;
      if (r.method !== ctx.req.method && !(r.method === "GET" && ctx.req.method === "HEAD")) continue;
      ctx.params = params;
      return r.handler(ctx);
    }
    if (pathMatched) throw new AppError(405, "method_not_allowed", "method not allowed");
    if (this.fallback && !ctx.url.pathname.startsWith("/api/")) return this.fallback(ctx);
    throw new AppError(404, "not_found", "not found");
  }
}

function split(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0);
}

function match(pattern: string[], path: string[]): Params | null {
  if (pattern.length !== path.length) return null;
  const out: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const s = path[i] as string;
    if (p.startsWith(":")) {
      try {
        out[p.slice(1)] = decodeURIComponent(s);
      } catch {
        return null;
      }
    } else if (p !== s) {
      return null;
    }
  }
  return out;
}
