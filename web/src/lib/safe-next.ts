// safeNext keeps only same-site paths from a ?next= value, so the sign-in flow cannot be used
// as an open redirect. Anything else falls back to "/".
export function safeNext(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}
