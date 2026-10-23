import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ApiError } from "./api";
import { createQueryClient, handleApiError, page } from "./query";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

describe("handleApiError stale toast", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  it("offers a Reload action that reloads the page", () => {
    const reload = vi.spyOn(page, "reload").mockImplementation(() => {});
    handleApiError(new ApiError(409, "stale", "changed"));

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(toast.error).mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
    expect(options.action.label).toBe("Reload");
    options.action.onClick();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });
});

describe("global mutation errors", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
  });

  async function failWith(err: unknown, meta?: Record<string, unknown>) {
    const qc = createQueryClient();
    await qc
      .getMutationCache()
      .build(qc, { mutationFn: () => Promise.reject(err), meta })
      .execute(undefined)
      .catch(() => {});
  }

  it.each([
    ["forbidden", new ApiError(403, "forbidden", "nope"), /permission/i],
    ["conflict", new ApiError(409, "version_not_ready", "Version 3 is not ready")],
    ["internal", new ApiError(500, "internal", "boom")],
    ["invalid without fields", new ApiError(422, "invalid", "bad input")],
  ])("toasts %s", async (_name, err, text?: RegExp) => {
    await failWith(err);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(toast.error).mock.calls[0][0] as string;
    expect(msg).toMatch(text ?? new RegExp(err.message));
  });

  it("leaves field errors and opted-out mutations to the form", async () => {
    await failWith(new ApiError(422, "invalid", "bad", { fields: { name: "required" } }));
    await failWith(new ApiError(403, "forbidden", "nope"), { skipGlobalError: true });
    await failWith(new ApiError(401, "unauthenticated", "signed out"));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not toast query errors the page shows inline", async () => {
    const qc = createQueryClient();
    await qc.fetchQuery({ queryKey: ["x"], queryFn: () => Promise.reject(new ApiError(403, "forbidden", "nope")) }).catch(() => {});
    expect(toast.error).not.toHaveBeenCalled();
  });
});
