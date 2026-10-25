// node --test scripts/ — checks the budget split: the lazy TS worker is measured on its own,
// not inside the editor chunk.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("worker is excluded from the editor chunk and reported separately", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), '<script type="module" src="/assets/index.js"></script>');
  fs.writeFileSync(path.join(dist, "assets/index.js"), "console.log(1)");
  fs.writeFileSync(path.join(dist, "assets/code.js"), "/* cm-editor */ export {}");
  fs.writeFileSync(path.join(dist, "assets/ts-worker-abc.js"), "x".repeat(10000));
  const out = execFileSync("node", [path.join(__dirname, "budget-measure.js"), dist], { encoding: "utf8" });
  const [first, editorGz, editorN, workerGz, workerN] = out.trim().split(" ").map(Number);
  assert.ok(first > 0);
  assert.strictEqual(editorN, 1, "editor count excludes the worker");
  assert.strictEqual(workerN, 1);
  assert.ok(workerGz > 0 && editorGz > 0);
});
