import { describe, expect, it } from "vitest";

import { eventNote, eventTitle, groupEvents, groupTitle } from "./event-text";

const sw = (id: number, kind: string, ts: number) => ({ id, ts, kind, service: "s1", data: { switch: "sw1", from: 1, to: 2, state: "x", error: null } });

describe("event text", () => {
  it("names known kinds and reads unknown ones as words", () => {
    expect(eventTitle("service.switch.flipped")).toBe("Traffic moved");
    expect(eventTitle("something.odd_happened")).toBe("Something odd happened");
  });

  it("keeps IDs and digests out of the note", () => {
    expect(eventNote({ id: 1, ts: 1, kind: "service.promoted", data: { from: 1, to: 2, sockets_closed: 0, key_id: "k1", digest: "sha256:aa" } })).toBe("Version 1 to 2");
    expect(eventNote({ id: 1, ts: 1, kind: "service.updated", data: { tenant: "t1" } })).toBeNull();
    expect(eventNote({ id: 1, ts: 1, kind: "x", data: { sockets_closed: 2 } })).toBe("2 sockets closed");
  });

  it("folds one switch into one group and keeps other events apart", () => {
    const groups = groupEvents([
      sw(5, "service.switch.drained", 500),
      sw(4, "service.switch.flipped", 400),
      { id: 3, ts: 390, kind: "service.promoted", service: "s1", data: { from: 1, to: 2 } },
      sw(2, "service.switch.started", 300),
      { id: 1, ts: 100, kind: "service.created", service: "s1", data: {} },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.events.map((e) => e.id)).toEqual([2, 3, 4, 5]);
    expect(groupTitle(groups[0]!)).toBe("Switched from version 1 to 2");
    expect(groupTitle(groups[1]!)).toBe("App created");
  });

  it("says when the switch failed", () => {
    const [g] = groupEvents([sw(2, "service.switch.failed", 2), sw(1, "service.switch.started", 1)]);
    expect(groupTitle(g!)).toBe("Switch to version 2 failed");
  });

  it("does not attach another App's promote to a switch", () => {
    const groups = groupEvents([sw(2, "service.switch.started", 1000), { id: 1, ts: 1000, kind: "service.promoted", service: "other", data: { to: 2 } }]);
    expect(groups).toHaveLength(2);
  });
});
