import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { apps, useShellHandlers } from "@/test/shell-fixtures";

import { useAppHandlers } from "./fixtures";

// Routes are code-split, so the first render of each test waits on a lazy chunk.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  setCsrfToken("csrf-token-1");
});

describe("app header", () => {
  it("status pill shows last_error", async () => {
    useShellHandlers();
    useAppHandlers();
    server.use(
      http.get("/api/orgs/:org/apps", () =>
        HttpResponse.json({
          items: apps.map((a) => ({ ...a, status: { ...a.status, build_state: "failed", last_error: "boom: bad import" } })),
          next_cursor: null,
        }),
      ),
    );
    renderAt("/acme/apps/hello");

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/boom: bad import/)).toBeInTheDocument();
  });
});
