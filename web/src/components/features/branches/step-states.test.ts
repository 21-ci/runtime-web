import { describe, expect, it } from "vitest";

import { stepStates } from "./use-branches";


describe("stepStates", () => {
  it("marks the current step and those around it", () => {
    expect(stepStates("preparing")).toEqual(["current", "todo", "todo", "todo"]);
    expect(stepStates("migrating")).toEqual(["done", "current", "todo", "todo"]);
    expect(stepStates("draining")).toEqual(["done", "done", "current", "todo"]);
  });

  it("completes every step", () => {
    expect(stepStates("completed")).toEqual(["done", "done", "done", "done"]);
  });

  it("places a drain timeout on the drain step", () => {
    expect(stepStates("drain_timed_out")).toEqual(["done", "done", "failed", "todo"]);
  });

  it("claims no steps for a failure, whose step the runtime does not report", () => {
    expect(stepStates("failed")).toBeNull();
  });
});
