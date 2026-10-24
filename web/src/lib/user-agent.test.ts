import { describe, expect, it } from "vitest";

import { describeUserAgent } from "./user-agent";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
};

describe("describeUserAgent", () => {
  it.each([
    ["chromeMac", "Chrome on macOS"],
    ["chromeLinux", "Chrome on Linux"],
    ["firefoxMac", "Firefox on macOS"],
    ["safariIphone", "Safari on iOS"],
    ["edgeWindows", "Edge on Windows"],
    ["chromeAndroid", "Chrome on Android"],
  ] as const)("parses %s", (key, label) => {
    expect(describeUserAgent(UA[key])).toBe(label);
  });

  it("falls back for empty or unknown agents", () => {
    expect(describeUserAgent("")).toBe("Unknown device");
    expect(describeUserAgent("curl/8.4.0")).toBe("Unknown browser");
  });
});
