// Prints "<first_route_gzip_bytes> <editor_gzip_bytes> <editor_chunk_count>" for a Vite dist dir.
// Used by scripts/budget.sh (kept as a file: bash 3.2 on macOS mis-parses heredocs in <(...)).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const dist = process.argv[2];
const gz = (file) => zlib.gzipSync(fs.readFileSync(file), { level: 6 }).length;

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const refs = new Set();
for (const m of html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)) refs.add(m[1]);
const firstFiles = [...refs].map((r) => path.join(dist, r)).filter((f) => fs.existsSync(f));
const first = firstFiles.reduce((sum, f) => sum + gz(f), 0);

const assets = path.join(dist, "assets");
const all = fs.existsSync(assets)
  ? fs.readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => path.join(assets, f))
  : [];
const editor = all.filter((f) => {
  if (firstFiles.includes(f)) return false;
  if (/worker/i.test(path.basename(f))) return true;
  return fs.readFileSync(f, "utf8").includes("cm-editor");
});
const editorGz = editor.reduce((sum, f) => sum + gz(f), 0);
console.log(`${first} ${editorGz} ${editor.length}`);
