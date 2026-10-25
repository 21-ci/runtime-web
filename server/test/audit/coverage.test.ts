// Every mutating route either records an audit action (named here, and present in src/)
// or is listed as deliberately not audited with a reason. A new route fails this test
// until it is classified.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testApp } from "../harness.ts";

const AUDITED: Record<string, string[]> = {
  "POST /api/orgs/:org/members": ["member.add"],
  "PATCH /api/orgs/:org/members/:user": ["member.role"],
  "DELETE /api/orgs/:org/members/:user": ["member.remove"],
  "PUT /api/orgs/:org/members/:user/grants/:project": ["grant.set"],
  "DELETE /api/orgs/:org/members/:user/grants/:project": ["grant.remove"],
  "POST /api/admin/users": ["user.create"],
  "PATCH /api/admin/users/:id": ["user.update"],
  "DELETE /api/admin/users/:id": ["user.delete"],
  "POST /api/admin/users/:id/reset-password": ["user.reset_password"],
  "DELETE /api/admin/users/:id/totp": ["user.reset_totp"],
  "POST /api/admin/orgs": ["org.create"],
  "PATCH /api/admin/orgs/:org": ["org.rename"],
  "DELETE /api/admin/orgs/:org": ["org.delete"],
  "POST /api/orgs/:org/invites": ["invite.create"],
  "DELETE /api/orgs/:org/invites/:id": ["invite.revoke"],
  "POST /api/admin/invites": ["invite.create"],
  "DELETE /api/admin/invites/:id": ["invite.revoke"],
  "POST /api/invites/accept/:token": ["invite.accept"],
  "POST /api/orgs/:org/tokens": ["token.create"],
  "DELETE /api/orgs/:org/tokens/:id": ["token.revoke"],
  "POST /api/orgs/:org/default-key/rotate": ["defaultkey.rotate"],
  "POST /api/orgs/:org/projects": ["project.create"],
  "PATCH /api/orgs/:org/projects/:p": ["project.update"],
  "DELETE /api/orgs/:org/projects/:p": ["project.delete"],
  "PUT /api/admin/node/config": ["node.config.update"],
  "POST /api/admin/node/drain": ["node.drain"],
  "POST /api/orgs/:org/apps": ["app.create"],
  "PATCH /api/orgs/:org/apps/:app": ["app.update"],
  "DELETE /api/orgs/:org/apps/:app": ["app.delete"],
  "PUT /api/orgs/:org/apps/:app/files": ["app.deploy"],
  "PUT /api/orgs/:org/apps/:app/live": ["app.live"],
  "POST /api/orgs/:org/apps/:app/versions/:v/rebuild": ["app.rebuild"],
  "PUT /api/orgs/:org/apps/:app/env": ["app.env"],
  "PUT /api/orgs/:org/apps/:app/secrets/:name": ["app.secret.set"],
  "DELETE /api/orgs/:org/apps/:app/secrets/:name": ["app.secret.delete"],
  "POST /api/orgs/:org/apps/:app/schedules": ["app.schedule.create"],
  "PATCH /api/orgs/:org/apps/:app/schedules/:id": ["app.schedule.update"],
  "DELETE /api/orgs/:org/apps/:app/schedules/:id": ["app.schedule.delete"],
  "POST /api/orgs/:org/apps/:app/queue": ["app.queue.send"],
  "DELETE /api/orgs/:org/apps/:app/dlq": ["app.dlq.purge"],
  "POST /api/orgs/:org/apps/:app/dlq/redrive": ["app.dlq.redrive"],
  "POST /api/orgs/:org/apps/:app/domains": ["domain.add"],
  "POST /api/orgs/:org/apps/:app/domains/:id/verify": ["domain.verify"],
  "DELETE /api/orgs/:org/apps/:app/domains/:id": ["domain.remove"],
  "PUT /api/admin/settings": ["settings.update"],
  "PUT /api/admin/branding": ["branding.update"],
  "DELETE /api/admin/branding": ["branding.reset"],
  "PUT /api/admin/branding/assets/:kind": ["branding.asset_update"],
  "DELETE /api/admin/branding/assets/:kind": ["branding.asset_delete"],
  // Setup's first org is audited by createOrg.
  "POST /api/setup": ["org.create"],
};

/** Mutating routes that write no audit row, and why. */
const NOT_AUDITED: Record<string, string> = {
  "POST /api/auth/login": "session lifecycle; sessions table is the record",
  "POST /api/auth/mfa": "session lifecycle",
  "POST /api/auth/logout": "session lifecycle",
  "PUT /api/me/password": "self-service on own account; no org scope",
  "POST /api/me/sessions/revoke-others": "self-service session management",
  "DELETE /api/me/sessions/:id": "self-service session management",
  "POST /api/me/totp/enroll": "self-service 2FA",
  "POST /api/me/totp/confirm": "self-service 2FA",
  "POST /api/me/totp/disable": "self-service 2FA",
  "POST /api/me/recovery-codes": "self-service 2FA",
  "POST /api/me/oauth/:provider/link": "starts an OAuth redirect; no state change yet",
  "PUT /api/internal/assets/:id/:part": "internal asset upload chunks; the deploy that uses them is audited",
};

function sources(dir: string): string {
  let out = "";
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out += sources(p);
    else if (p.endsWith(".ts")) out += readFileSync(p, "utf8");
  }
  return out;
}

describe("audit coverage of mutating routes", () => {
  const routes = testApp({ spa: { assets: {} } })
    .routes()
    .filter((r) => r.method !== "GET" && r.method !== "HEAD")
    .map((r) => `${r.method} ${r.pattern}`);
  const src = sources(new URL("../../src", import.meta.url).pathname);

  it("every mutating route is classified", () => {
    const unclassified = routes.filter((k) => !(k in AUDITED) && !(k in NOT_AUDITED));
    expect(unclassified).toEqual([]);
  });

  it("the lists name only registered routes", () => {
    const stale = [...Object.keys(AUDITED), ...Object.keys(NOT_AUDITED)].filter((k) => !routes.includes(k));
    expect(stale).toEqual([]);
  });

  it("every audited action is recorded somewhere in src/", () => {
    const missing = Object.values(AUDITED).flat().filter((a) => !src.includes(`"${a}"`));
    expect(missing).toEqual([]);
  });
});
