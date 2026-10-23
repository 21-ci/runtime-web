import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");

describe("index.html is CSP-safe (default-src 'self')", () => {
  it("has no inline <script> bodies", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\ssrc="/);
      expect(body.trim()).toBe("");
    }
  });

  it("has no inline event handler attributes", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("loads the theme init script blocking in <head>", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<script src="\/theme-init\.js"><\/script>/);
  });
});
