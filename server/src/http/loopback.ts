// Loopback-only guard for /api/internal/* routes. The client address is the one the
// runtime resolved (ctx.client.ip, or its x-rt-client-ip which clients cannot set);
// an unknown address is treated as remote. Remote callers get a plain 404 so the
// routes are indistinguishable from missing ones.

import { notFound } from "./errors.ts";
import type { Handler } from "./router.ts";

/** True for 127.0.0.0/8, ::1 and IPv4-mapped 127.0.0.0/8. */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  let v = ip.trim().toLowerCase();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  if (v.startsWith("::ffff:")) v = v.slice(7);
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Wraps h so that only loopback clients reach it; everyone else gets 404. */
export function loopbackOnly(h: Handler): Handler {
  return async (ctx) => {
    if (!isLoopback(ctx.clientIp)) throw notFound();
    return h(ctx);
  };
}
