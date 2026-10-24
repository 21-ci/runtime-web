import { describe, expect, it } from "vitest";
import { AppError } from "../../src/http/errors.ts";
import { bool, email, int, oneOf, parse, str } from "../../src/http/validate.ts";

const catchErr = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected AppError");
};

describe("validate.parse", () => {
  it("returns typed values for valid input", () => {
    const out = parse(
      { name: "  Ada  ", email: " ADA@Example.com ", age: 36, admin: true, role: "owner" },
      {
        name: str({ min: 1, max: 80, trim: true }),
        email: email(),
        age: int({ min: 0, max: 150 }),
        admin: bool(),
        role: oneOf(["owner", "member"] as const),
      },
    );
    expect(out).toEqual({ name: "Ada", email: "ada@example.com", age: 36, admin: true, role: "owner" });
  });

  it("throws 422 invalid with a field map for every bad field", () => {
    const err = catchErr(() =>
      parse(
        { name: "", email: "nope", age: 1.5, admin: "yes", role: "root" },
        {
          name: str({ min: 1 }),
          email: email(),
          age: int({ min: 0 }),
          admin: bool(),
          role: oneOf(["owner", "member"] as const),
        },
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe("invalid");
    expect(err.details).toEqual({
      fields: { name: "required", email: "invalid_format", age: "not_integer", admin: "not_boolean", role: "not_one_of" },
    });
  });

  it("reports missing and non-object bodies as fields", () => {
    const err = catchErr(() => parse({}, { name: str({ min: 1 }) }));
    expect(err.details).toEqual({ fields: { name: "required" } });
  });

  it("enforces length bounds by code points, like the Go validator", () => {
    expect(() => parse({ s: "🙂🙂🙂" }, { s: str({ min: 3, max: 3 }) })).not.toThrow();
    const err = catchErr(() => parse({ s: "ab" }, { s: str({ min: 3 }) }));
    expect(err.details).toEqual({ fields: { s: "too_short" } });
    const long = catchErr(() => parse({ s: "abcd" }, { s: str({ max: 3 }) }));
    expect(long.details).toEqual({ fields: { s: "too_long" } });
  });

  it("optional fields may be absent or null", () => {
    const out = parse({ note: null }, { note: str({ optional: true }), other: str({ optional: true }) });
    expect(out).toEqual({ note: undefined, other: undefined });
  });

  it("int rejects strings and out-of-range numbers", () => {
    const err = catchErr(() => parse({ n: "5" }, { n: int({ min: 0, max: 3 }) }));
    expect(err.details).toEqual({ fields: { n: "not_integer" } });
    const range = catchErr(() => parse({ n: 9 }, { n: int({ min: 0, max: 3 }) }));
    expect(range.details).toEqual({ fields: { n: "out_of_range" } });
  });
});
