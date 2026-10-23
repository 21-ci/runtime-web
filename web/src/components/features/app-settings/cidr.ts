const IPV4_OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`);

function isIPv6(addr: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(addr)) return false;
  const halves = addr.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const max = halves.length === 2 ? 7 : 8;
  return groups.length <= max && (halves.length === 2 || groups.length === 8);
}

// isCidr reports whether v is an IPv4 or IPv6 address with a prefix length (for example 10.0.0.0/8
// or 2001:db8::/32). A bare address without /len is rejected: ip_allow lists prefixes.
export function isCidr(v: string): boolean {
  const m = /^(.+)\/(\d{1,3})$/.exec(v.trim());
  if (!m) return false;
  const addr = m[1];
  const bits = Number(m[2]);
  if (addr.includes(":")) return isIPv6(addr) && bits <= 128;
  return IPV4.test(addr) && bits <= 32;
}
