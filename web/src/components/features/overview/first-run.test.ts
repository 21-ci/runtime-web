import { describe, expect, it } from "vitest";

import { sampleCurl } from "./first-run";

describe("sampleCurl", () => {
  it("posts and lists items for the SQLite template", () => {
    const out = sampleCurl("https://todo.example.test/", 'if (path.endsWith("/items"))', false);
    expect(out).toContain("-X POST https://todo.example.test/items");
    expect(out).toContain("curl https://todo.example.test/items");
  });

  it("posts a message for the queue template", () => {
    expect(sampleCurl("https://q.example.test", 'import { enqueue } from "std:queue";', false)).toContain("-X POST https://q.example.test/");
  });

  it("is a plain GET otherwise, and carries a token when the App needs one", () => {
    expect(sampleCurl("https://a.example.test", "export default {}", false)).toBe("curl https://a.example.test/");
    expect(sampleCurl("https://a.example.test", "export default {}", true)).toContain('Authorization: Bearer $TOKEN');
  });
});
