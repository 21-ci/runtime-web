// describeUserAgent turns a raw User-Agent header into a short device label such as
// "Chrome on macOS". It is a small, ordered pattern list (no dependency): browser checks run
// before the engines they embed (Edge and Opera before Chrome, Chrome before Safari), and Android
// is checked before Linux. Anything it does not recognise becomes a generic word.
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux|X11/, "Linux"],
];

export function describeUserAgent(ua: string): string {
  const agent = ua.trim();
  if (agent === "") return "Unknown device";

  const browser = BROWSERS.find(([re]) => re.test(agent))?.[1] ?? "Unknown browser";
  const system = SYSTEMS.find(([re]) => re.test(agent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
