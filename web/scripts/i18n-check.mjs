#!/usr/bin/env node
// i18n-check compares every locale with English (the source) under web/src/locales:
//   - missing: a key (or a plural form the language needs) that en has and the locale lacks
//   - extra: a key the locale has and en does not
//   - mismatch: different {{interpolation}} variables or <tag> components than en
// Plural keys follow i18next: <key>_one / _few / _many / _other. The forms a locale must provide
// come from Intl.PluralRules (ru: one, few, many, other; uz: one, other).
//
// Usage: node scripts/i18n-check.mjs [--allow-missing]
//   --allow-missing reports missing keys as warnings (for the transition while features are
//   converted); extra keys and mismatches still fail.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const SOURCE = "en";
const PLURAL = /_(zero|one|two|few|many|other)$/;
const allowMissing = process.argv.includes("--allow-missing");

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") flatten(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

function load(lang, ns) {
  const file = join(ROOT, lang, `${ns}.json`);
  if (!existsSync(file)) return null;
  try {
    return flatten(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    throw new Error(`${lang}/${ns}.json: invalid JSON (${err.message})`);
  }
}

// placeholders returns the sorted {{vars}} and <tags> of a message, the parts a translation must keep.
function placeholders(text) {
  const vars = [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => `{{${m[1]}}}`);
  const tags = [...text.matchAll(/<(\/?)([\w]+)\s*\/?>/g)].map((m) => `<${m[1]}${m[2]}>`);
  return [...new Set([...vars, ...tags])].sort().join(" ");
}

// group splits flat keys into plain keys and plural bases with their forms.
function group(map) {
  const plain = new Map();
  const plurals = new Map();
  for (const [key, text] of map) {
    const m = key.match(PLURAL);
    if (m) {
      const base = key.slice(0, -m[0].length);
      if (!plurals.has(base)) plurals.set(base, new Map());
      plurals.get(base).set(m[1], text);
    } else plain.set(key, text);
  }
  return { plain, plurals };
}

const namespaces = readdirSync(join(ROOT, SOURCE))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();
const locales = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== SOURCE)
  .map((d) => d.name)
  .sort();

let errors = 0;
let warnings = 0;
const report = (level, msg) => {
  if (level === "error") errors++;
  else warnings++;
  console.log(`${level === "error" ? "ERROR" : "WARN "} ${msg}`);
};

for (const lang of locales) {
  const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  let missing = 0;
  const missingLevel = allowMissing ? "warn" : "error";

  for (const extra of readdirSync(join(ROOT, lang)).filter((f) => f.endsWith(".json"))) {
    if (!namespaces.includes(extra.slice(0, -5))) report("error", `${lang}/${extra}: namespace not in en`);
  }

  for (const ns of namespaces) {
    const en = group(load(SOURCE, ns));
    const raw = load(lang, ns);
    if (!raw) {
      report("error", `${lang}/${ns}.json: file missing (create it with {} at least)`);
      continue;
    }
    const tr = group(raw);
    const where = `${lang}/${ns}`;

    for (const [key, text] of en.plain) {
      if (!tr.plain.has(key)) {
        missing++;
        if (!allowMissing) report(missingLevel, `${where}: missing "${key}"`);
      } else if (placeholders(text) !== placeholders(tr.plain.get(key))) {
        report("error", `${where}: "${key}" uses [${placeholders(tr.plain.get(key))}], en uses [${placeholders(text)}]`);
      }
    }
    for (const key of tr.plain.keys()) {
      if (!en.plain.has(key)) report("error", `${where}: extra key "${key}" (not in en)`);
    }

    for (const [base, enForms] of en.plurals) {
      const expected = placeholders(enForms.get("other") ?? [...enForms.values()][0]);
      const got = tr.plurals.get(base);
      if (!got) {
        missing++;
        if (!allowMissing) report(missingLevel, `${where}: missing plural "${base}" (${forms.map((f) => `_${f}`).join(", ")})`);
        continue;
      }
      for (const f of forms) {
        if (!got.has(f)) report("error", `${where}: plural "${base}" lacks _${f}`);
      }
      for (const [f, text] of got) {
        if (!forms.includes(f)) report("error", `${where}: plural "${base}_${f}" is not a ${lang} plural form`);
        else if (placeholders(text) !== expected) {
          report("error", `${where}: "${base}_${f}" uses [${placeholders(text)}], en uses [${expected}]`);
        }
      }
    }
    for (const base of tr.plurals.keys()) {
      if (!en.plurals.has(base)) report("error", `${where}: extra plural "${base}" (not in en)`);
    }
  }
  if (missing > 0 && allowMissing) report("warn", `${lang}: ${missing} keys not translated yet (--allow-missing)`);
}

console.log(errors === 0 ? `i18n-check: OK (${warnings} warnings)` : `i18n-check: ${errors} errors, ${warnings} warnings`);
process.exit(errors === 0 ? 0 : 1);
