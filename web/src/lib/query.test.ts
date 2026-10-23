import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ApiError } from "./api";
import { handleApiError, page } from "./query";

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
