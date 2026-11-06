import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { AppPreview, highlightJson } from "./app-preview";

const URL_ = "https://hello.apps.example.test/";
const ROUTE = "/api/orgs/acme/apps/hello/preview";

function setup(answer: () => Response, refreshKey = 0) {
  const counter = { calls: 0 };
  server.use(
    http.post(ROUTE, () => {
      counter.calls++;
      return answer();
    }),
  );
  const client = createQueryClient();
  const ui = (key: number) => (
    <QueryClientProvider client={client}>
      <AppPreview org="acme" app="hello" url={URL_} title="App preview" refreshKey={key} />
    </QueryClientProvider>
  );
  const view = render(ui(refreshKey));
  return { counter, rerender: (key: number) => view.rerender(ui(key)) };
}

const body = (over: object) => HttpResponse.json({ status: 200, content_type: "application/json", body: '{"a":1}', truncated: false, ...over });
const load = () => userEvent.click(screen.getByRole("button", { name: /load preview/i }));

afterEach(cleanup);

describe("AppPreview", () => {
  it("does not call the app until asked, and a refresh before that stays quiet", async () => {
    const { counter, rerender } = setup(() => body({}));
    expect(screen.queryByTitle("App preview")).toBeNull();
    rerender(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(counter.calls).toBe(0);
    await load();
    await screen.findByText("HTTP 200");
    expect(counter.calls).toBe(1);
  });

  it("pretty-prints JSON by default in the console's theme, and can show the raw text", async () => {
    setup(() => body({}));
    await load();
    const code = await screen.findByLabelText("Response body");
    expect(code.textContent).toBe('{\n  "a": 1\n}');
    expect(code.querySelector(".text-tag-blue-text")?.textContent).toBe('"a"');
    expect(screen.queryByTitle("App preview")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: /pretty-print/i }));
    expect(screen.getByLabelText("Response body").textContent).toBe('{"a":1}');
  });

  it("treats a hostile body as text", async () => {
    setup(() => body({ content_type: "text/plain", body: "<img src=x onerror=alert(1)>" }));
    await load();
    const code = await screen.findByLabelText("Response body");
    expect(code.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(code.querySelector("img")).toBeNull();
  });

  it("says a key is needed instead of framing a bare refusal", async () => {
    setup(() => body({ status: null, content_type: null, body: null, needs_key: true }));
    await load();
    expect(await screen.findByRole("status")).toHaveTextContent("needs an API key");
    expect(screen.queryByTitle("App preview")).toBeNull();
  });

  it("frames an HTML app", async () => {
    setup(() => body({ content_type: "text/html", body: "<h1>hi</h1>" }));
    await load();
    expect((await screen.findByTitle("App preview")).getAttribute("src")).toBe(URL_);
  });

  it("falls back to a frame when the console cannot reach the app", async () => {
    setup(() => HttpResponse.json({ error: { code: "preview_unavailable", message: "x" } }, { status: 502 }));
    await load();
    expect((await screen.findByTitle("App preview")).getAttribute("src")).toBe(URL_);
  });

  it("explains a 401 and says when the body was cut", async () => {
    setup(() => body({ status: 401, body: '{"error":"unauthorized"', truncated: true }));
    await load();
    expect(await screen.findByText(/needs a key/i)).toBeInTheDocument();
    expect(screen.getByText(/first part/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Response body").textContent).toBe('{"error":"unauthorized"');
  });

  it("calls again on reload and on a refresh once loaded", async () => {
    const { counter, rerender } = setup(() => body({}));
    await load();
    await screen.findByText("HTTP 200");
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(counter.calls).toBe(2));
    rerender(1);
    await waitFor(() => expect(counter.calls).toBe(3));
  });
});

describe("highlightJson", () => {
  it("keeps every character", () => {
    const text = JSON.stringify({ k: "v: \"x\"", n: -1.5e3, t: true, z: null, l: [1, "a"] }, null, 2);
    const { container } = render(<code>{highlightJson(text)}</code>);
    expect(container.textContent).toBe(text);
  });
});
