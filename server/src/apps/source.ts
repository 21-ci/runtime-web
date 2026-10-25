// App source ↔ editor Files. Supported formats:
// TypeScript/JavaScript single files, the runtime JSON bundle {entry, files}, and
// wasm (read-only). zip/tar archives (CLI uploads) are shown read-only with no files
// in this port: unpacking them needs a zip/tar reader we do not ship.

import { invalid } from "../http/errors.ts";

export const MAX_BUNDLE_BYTES = 10 << 20;
/** Per-file cap for PUT …/files (design §4). */
export const MAX_FILE_BYTES = 1 << 20;

export interface Files {
  entry: string;
  files: Record<string, string>;
  read_only: boolean;
  kind: "ts" | "js" | "bundle" | "wasm";
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

function kindOf(ct: string): string {
  const mt = (ct.split(";")[0] ?? "").trim().toLowerCase();
  switch (mt) {
    case "application/typescript":
    case "text/typescript":
    case "text/x-typescript":
      return "ts";
    case "text/javascript":
    case "application/javascript":
      return "js";
    case "application/json":
      return "json";
    case "application/zip":
    case "application/x-tar":
      return "archive";
    case "application/wasm":
      return "wasm";
  }
  return "";
}

/** "archive" / "wasm" by magic bytes (a binary string), else "". */
function binaryKind(body: string): string {
  if (body.startsWith("PK\x03\x04")) return "archive";
  if (body.startsWith("\x00asm")) return "wasm";
  if (body.length >= 262 && body.slice(257, 262) === "ustar") return "archive";
  return "";
}

function sniff(body: string): string {
  const bin = binaryKind(body);
  if (bin) return bin;
  try {
    const v: unknown = JSON.parse(body);
    if (v && typeof v === "object" && !Array.isArray(v) && "entry" in v) return "json";
  } catch {
    // not JSON
  }
  return "ts";
}

/** Turns stored source text (or base64 when `base64`) into Files. */
export function unpack(body: string, contentType: string, base64 = false): Files {
  let kind = kindOf(contentType);
  if (base64 && kind !== "wasm" && kind !== "archive") {
    const raw = atob(body);
    // No useful type (the runtime serves stored source as application/octet-stream): sniff the bytes.
    if (!kind) kind = binaryKind(raw);
    if (!kind) body = new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  }
  if (!kind) kind = sniff(body);
  switch (kind) {
    case "wasm":
      return { entry: "", files: {}, read_only: true, kind: "wasm" };
    case "archive":
      return { entry: "", files: {}, read_only: true, kind: "bundle" };
    case "ts":
    case "js": {
      const name = `main.${kind}`;
      return { entry: name, files: { [name]: body }, read_only: false, kind };
    }
    case "json": {
      let b: { entry?: unknown; files?: unknown };
      try {
        b = JSON.parse(body) as typeof b;
      } catch {
        throw invalid({ source: "invalid_format" });
      }
      return checkBundle(String(b.entry ?? ""), (b.files ?? {}) as Record<string, string>, MAX_BUNDLE_BYTES);
    }
  }
  throw invalid({ source: "invalid_format" });
}

/** Clean relative paths only (no abs, backslash, .., ./, //). */
export function checkPath(name: string): boolean {
  if (!name || name.startsWith("/") || name.includes("\\")) return false;
  const parts = name.split("/");
  return parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** Validates a bundle; throws 422 invalid with field errors. */
export function checkBundle(entry: string, files: Record<string, unknown>, perFile: number): Files {
  const fields: Record<string, string> = {};
  const out: Record<string, string> = {};
  let total = 0;
  for (const [name, src] of Object.entries(files ?? {})) {
    if (!checkPath(name)) {
      fields[`files.${name}`] = "invalid_format";
      continue;
    }
    if (typeof src !== "string") {
      fields[`files.${name}`] = "not_string";
      continue;
    }
    const n = utf8Len(src);
    if (n > perFile) fields[`files.${name}`] = "too_long";
    total += n;
    out[name] = src;
  }
  if (total > MAX_BUNDLE_BYTES) fields.files = "too_long";
  if (!entry || !(entry in out)) fields.entry = "not_one_of";
  if (Object.keys(fields).length) throw invalid(fields);
  return { entry, files: out, read_only: false, kind: "bundle" };
}
