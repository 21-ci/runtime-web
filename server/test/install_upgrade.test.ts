import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const run = (...args: string[]) => {
  const r = spawnSync("sh", ["../install.sh", "--dry-run", ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("install.sh --upgrade-runtime", () => {
  it("needs a version", () => {
    const r = run("--upgrade-runtime");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("needs --runtime-version");
  });

  it("is for bare mode only", () => {
    const r = run("--upgrade-runtime", "--runtime-version", "9.9.9", "--mode", "docker");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("bare mode");
  });

  it("verifies the signature and checksum before it touches the binary, then restarts", () => {
    const r = run("--upgrade-runtime", "--runtime-version", "9.9.9");
    expect(r.code).toBe(0);
    const at = (s: string) => r.out.indexOf(s);
    expect(at("cosign verify-blob")).toBeGreaterThan(-1);
    expect(at("would verify sha256")).toBeGreaterThan(at("cosign verify-blob"));
    expect(at("cp -p /usr/bin/rt /usr/bin/rt.previous")).toBeGreaterThan(at("would verify sha256"));
    expect(at("/usr/bin/rt\n")).toBeGreaterThan(at("rt.previous"));
    expect(at("systemctl restart rt")).toBeGreaterThan(at("rt.previous"));
    expect(r.out).not.toContain("useradd");
  });

  it("leaves a plain install's existing-rt behaviour to the explicit flag", () => {
    const r = run("--version", "0.0.0", "--domain", "console.example.com", "--email", "ops@acme-corp.dev");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("rt.previous");
  });
});
