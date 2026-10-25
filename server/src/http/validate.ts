// Request-body validation. Each rule parses one JSON value into a typed value or
// records an error code; `parse` collects every failing field and throws the
// `422 invalid` AppError with `details.fields` (api-web §1.4, keyed by field name).
//
// Error codes (stable, the SPA maps them to text): `required`, `not_string`,
// `too_short`, `too_long`, `invalid_format`, `not_integer`, `out_of_range`,
// `not_boolean`, `not_one_of`.
//
// Lengths count code points, as the Go validator does (rune count).

import { invalid } from "./errors.ts";

export type FieldError = string;

/** A rule parses `raw` to a value, or returns a FieldError code. Absent/null is handled by the rule. */
export type Rule<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; error: FieldError };

export type Schema = Record<string, Rule<unknown>>;
export type Infer<S extends Schema> = { [K in keyof S]: S[K] extends Rule<infer T> ? T : never };

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (error: FieldError) => ({ ok: false as const, error });

const isAbsent = (raw: unknown) => raw === undefined || raw === null;

export interface StrOpts {
  min?: number;
  max?: number;
  /** Trim surrounding whitespace before the length checks. Default false. */
  trim?: boolean;
  /** Absent or null yields undefined instead of `required`. */
  optional?: boolean;
  pattern?: RegExp;
}

/** String field. */
export function str(opts: StrOpts & { optional: true }): Rule<string | undefined>;
export function str(opts?: StrOpts & { optional?: false }): Rule<string>;
export function str(opts: StrOpts = {}): Rule<string | undefined> {
  return (raw) => {
    if (isAbsent(raw)) return opts.optional ? ok(undefined) : fail("required");
    if (typeof raw !== "string") return fail("not_string");
    const v = opts.trim ? raw.trim() : raw;
    const n = [...v].length;
    if (opts.min !== undefined && n < opts.min) return v.length === 0 && opts.min > 0 ? fail("required") : fail("too_short");
    if (opts.max !== undefined && n > opts.max) return fail("too_long");
    if (opts.pattern && !opts.pattern.test(v)) return fail("invalid_format");
    return ok(v);
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email: trimmed, lower-cased, basic shape check, max 254 chars. */
export function email(opts: { optional: true }): Rule<string | undefined>;
export function email(opts?: { optional?: false }): Rule<string>;
export function email(opts: { optional?: boolean } = {}): Rule<string | undefined> {
  const base = { trim: true, max: 254 };
  const s: Rule<string | undefined> = opts.optional === true ? str({ ...base, optional: true }) : str(base);
  return (raw) => {
    const r = s(raw);
    if (!r.ok) return r;
    if (r.value === undefined) return ok(undefined);
    const v = r.value.toLowerCase();
    return EMAIL.test(v) ? ok(v) : fail("invalid_format");
  };
}

/** Integer field (JSON numbers only; strings are rejected). */
export function int(opts: { min?: number; max?: number } = {}): Rule<number> {
  return (raw) => {
    if (isAbsent(raw)) return fail("required");
    if (typeof raw !== "number" || !Number.isInteger(raw)) return fail("not_integer");
    if (opts.min !== undefined && raw < opts.min) return fail("out_of_range");
    if (opts.max !== undefined && raw > opts.max) return fail("out_of_range");
    return ok(raw);
  };
}

/** Boolean field. */
export function bool(): Rule<boolean> {
  return (raw) => {
    if (isAbsent(raw)) return fail("required");
    return typeof raw === "boolean" ? ok(raw) : fail("not_boolean");
  };
}

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly string[]>(values: T): Rule<T[number]> {
  return (raw) => {
    if (isAbsent(raw)) return fail("required");
    return typeof raw === "string" && (values as readonly string[]).includes(raw) ? ok(raw as T[number]) : fail("not_one_of");
  };
}

/**
 * Validates a parsed JSON body against schema. Returns the typed object, or throws
 * AppError 422 `invalid` with `details.fields` listing every failing field. A body
 * that is not a JSON object fails every field with `required`.
 */
export function parse<S extends Schema>(body: unknown, schema: S): Infer<S> {
  const obj = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const fields: Record<string, string> = {};
  for (const key of Object.keys(schema)) {
    const r = (schema[key] as Rule<unknown>)(obj[key]);
    if (r.ok) out[key] = r.value;
    else fields[key] = r.error;
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return out as Infer<S>;
}
