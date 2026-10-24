/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { describe, expect, it } from "vitest";
import { Actions, can, defaultKeyScopes, scopesFor, type Subject } from "../../src/authz/policy.ts";

const slug = "web";
const cols: [string, Subject][] = [
  ["owner", { userId: "u1", orgRole: "owner" }],
  ["admin", { userId: "u2", orgRole: "admin" }],
  ["member+admin", { userId: "u3", orgRole: "member", projectRoles: { web: "admin" } }],
  ["member+developer", { userId: "u4", orgRole: "member", projectRoles: { web: "developer" } }],
  ["member+viewer", { userId: "u5", orgRole: "member", projectRoles: { web: "viewer" } }],
  ["member no grant", { userId: "u6", orgRole: "member" }],
  ["non-member", { userId: "u7" }],
  ["instance admin", { userId: "u8", instanceAdmin: true }],
];
const T = true,
  F = false;
const matrix: [string, boolean[]][] = [
  ["org.read", [T, T, T, T, T, T, F, T]],
  ["org.update", [T, T, F, F, F, F, F, T]],
  ["org.delete", [T, F, F, F, F, F, F, T]],
  ["org.audit.read", [T, T, F, F, F, F, F, T]],
  ["org.usage.read", [T, T, F, F, F, F, F, T]],
  ["members.manage", [T, T, F, F, F, F, F, T]],
  ["members.owners", [T, F, F, F, F, F, F, T]],
  ["invites.manage", [T, T, F, F, F, F, F, T]],
  ["tokens.manage", [T, T, F, F, F, F, F, T]],
  ["defaultkey.rotate", [T, T, F, F, F, F, F, T]],
  ["project.create", [T, T, F, F, F, F, F, T]],
  ["project.read", [T, T, T, T, T, F, F, T]],
  ["project.update", [T, T, T, F, F, F, F, T]],
  ["project.delete", [T, T, F, F, F, F, F, T]],
  ["grants.manage", [T, T, T, F, F, F, F, T]],
  ["domains.manage", [T, T, T, F, F, F, F, T]],
  ["app.read", [T, T, T, T, T, F, F, T]],
  ["app.create", [T, T, T, T, F, F, F, T]],
  ["app.update", [T, T, T, T, F, F, F, T]],
  ["app.delete", [T, T, T, T, F, F, F, T]],
  ["app.deploy", [T, T, T, T, F, F, F, T]],
  ["app.env.write", [T, T, T, T, F, F, F, T]],
  ["app.secrets.write", [T, T, T, F, F, F, F, T]],
  ["app.schedules.write", [T, T, T, T, F, F, F, T]],
  ["app.queue.write", [T, T, T, T, F, F, F, T]],
  ["app.logs.read", [T, T, T, T, T, F, F, T]],
  ["app.data.export", [T, T, T, F, F, F, F, T]],
  ["instance.admin", [F, F, F, F, F, F, F, T]],
];

describe("authz", () => {
  it("matrix covers every action", () => {
    expect(matrix.map((m) => m[0]).sort()).toEqual([...Actions].sort());
  });

  it.each(matrix)("%s", (action, want) => {
    const got = cols.map(([, s]) => can(s, action, slug));
    expect(got).toEqual(want);
  });

  it("unknown action and prototype keys are denied", () => {
    for (const [, s] of cols) {
      expect(can(s, "app.nuke", slug)).toBe(false);
      expect(can(s, "constructor", slug)).toBe(false);
    }
  });

  it("cross-org and cross-project isolation", () => {
    const stale: Subject = { userId: "u9", projectRoles: { web: "admin" } };
    for (const a of Actions) {
      expect(can({ userId: "u7" }, a, slug)).toBe(false);
      expect(can(stale, a, slug)).toBe(false);
    }
    const memAdmin = cols[2]![1];
    for (const a of ["project.read", "app.read", "app.deploy", "app.secrets.write", "grants.manage", "domains.manage"]) {
      expect(can(memAdmin, a, "web")).toBe(true);
      expect(can(memAdmin, a, "api")).toBe(false);
      expect(can(memAdmin, a, "")).toBe(false);
    }
  });

  it("default key scopes", () => {
    expect(defaultKeyScopes()).toEqual(["services:read", "logs:read", "services:write", "deploy", "env:write", "queue:write", "invoke", "secrets:write", "data:admin", "sockets:write"]);
  });

  it("scopesFor", () => {
    expect(scopesFor("viewer")).toEqual(["services:read", "logs:read"]);
    expect(scopesFor("developer")).toHaveLength(7);
    expect(scopesFor("admin")).toEqual([...defaultKeyScopes(), "keys:write"]);
    expect(scopesFor("owner")).toEqual(scopesFor("admin"));
    expect(scopesFor("member")).toBeNull();
    const v = scopesFor("viewer")!;
    v[0] = "x";
    expect(scopesFor("viewer")![0]).toBe("services:read");
  });
});
