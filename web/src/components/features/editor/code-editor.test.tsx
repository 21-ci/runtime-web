import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { apiError, server } from "@/test/msw";
import { renderAt } from "@/test/render";
import { apps, orgs, projects, useShellHandlers } from "@/test/shell-fixtures";

// jsdom has no layout; CodeMirror measures text ranges.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const BASE = "/api/orgs/acme/apps/hello";

const appView = {
  ...apps[0],
  etag: '"e1"',
  runtime: "deno",
  profile: null,
  access: "public",
  url: "https://run.example.test/s/hello/",
  scaling: null,
  ingress: null,
  egress: null,
  call: null,
  triggers: null,
  status: { ...apps[0].status, inflight: 0, admission: null },
  limits: { requested: null, effective: {}, source: "plan" },
};

const files: { version: number; entry: string; files: Record<string, string>; read_only: boolean; kind: string } = {
  version: 1,
  entry: "main.ts",
  files: { "main.ts": 'export default () => new Response("hi");\n' },
  read_only: false,
  kind: "ts",
};

function version(n: number, state = "ready") {
  return {
    version: n,
    build_state: state,
    live: state === "ready",
    source_digest: "d",
    failure: null,
    author: null,
    created_at: 1,
  };
}

function useCodeHandlers(opts: { files?: typeof files; onPut?: (req: Request) => void } = {}) {
  server.use(
    http.get(BASE, () => HttpResponse.json(appView)),
    http.get(`${BASE}/files`, () => HttpResponse.json(opts.files ?? files)),
    http.get(`${BASE}/versions`, () => HttpResponse.json({ items: [version(2), version(1)] })),
    http.put(`${BASE}/files`, async ({ request }) => {
      opts.onPut?.(request);
      await delay(50);
      return HttpResponse.json({ version: version(2), etag: '"e2"' });
    }),
  );
}

async function openEditor() {
  renderAt("/acme/apps/hello/code");
  return await screen.findByRole("textbox", { name: /code editor/i });
}

function pressSave() {
  fireEvent.keyDown(document, { key: "s", metaKey: true });
}

describe("code editor", () => {
  afterEach(() => setCsrfToken(null));

  it("viewer sees read-only editor and no Save", async () => {
    useShellHandlers();
    server.use(
      http.get("/api/orgs", () => HttpResponse.json({ items: [{ ...orgs[0], role: "member" }] })),
      http.get("/api/orgs/acme/projects", () =>
        HttpResponse.json({ items: [{ ...projects[0], role: "viewer" }] }),
      ),
    );
    useCodeHandlers();
    const editor = await openEditor();
    await waitFor(() => expect(editor).toHaveAttribute("contenteditable", "false"));
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("a route change with unsaved edits asks first; Cancel stays, Discard leaves", async () => {
    useShellHandlers();
    useCodeHandlers();
    const router = renderAt("/acme/apps/hello/code");
    const editor = await screen.findByRole("textbox", { name: /code editor/i });
    await screen.findByRole("button", { name: /save/i });
    const cm = EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no EditorView");
    act(() => cm.dispatch({ changes: { from: 0, insert: "// edit\n" } }));
    await screen.findByRole("button", { name: /save \*/i });
    act(() => void router.navigate({ to: "/$org/apps/$app/versions", params: { org: "acme", app: "hello" } }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Leave without saving?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(router.state.location.pathname).toBe("/acme/apps/hello/code");
    act(() => void router.navigate({ to: "/$org/apps/$app/versions", params: { org: "acme", app: "hello" } }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/acme/apps/hello/versions"));
  });

  it("cmd+s triggers save mutation", async () => {
    useShellHandlers();
    let ifMatch: string | null = null;
    let body: unknown = null;
    useCodeHandlers({
      onPut: (req) => {
        ifMatch = req.headers.get("If-Match");
        void req.clone().json().then((b) => (body = b));
      },
    });
    await openEditor();
    await screen.findByRole("button", { name: /save/i });
    pressSave();
    await waitFor(() => expect(ifMatch).toBe('"e1"'));
    await waitFor(() => expect(body).toEqual({ entry: "main.ts", files: files.files }));
  });

  it("save shows building then saved (not live); Deploy makes it live", async () => {
    useShellHandlers();
    useCodeHandlers();
    // The build stays in progress until the test releases it. A fixed server delay would make the
    // "building" state a race against the render, which is what flaked under load.
    let built = false;
    server.use(
      http.put(`${BASE}/files`, () =>
        HttpResponse.json({ version: version(2, "building"), etag: '"e2"' }),
      ),
      http.get(`${BASE}/versions`, () =>
        HttpResponse.json({ items: [version(2, built ? "ready" : "building"), version(1)] }),
      ),
    );
    await openEditor();
    await userEvent.click(await screen.findByRole("button", { name: /save/i }));
    expect(await screen.findByText(/building/i)).toBeInTheDocument();
    built = true;
    const saved = await screen.findByRole("link", { name: /saved v2, not live/i });
    expect(saved.getAttribute("href")).toContain("/acme/apps/hello/versions");
    // The preview stays on the live version: the runtime cannot address a saved one.
    expect(screen.getByText(/preview shows the live version \(v1\)/i)).toBeInTheDocument();
    const frame = screen.getByTitle(/preview/i);
    expect(frame.getAttribute("src")).toContain("https://run.example.test/s/hello/");
    let promoted: unknown = null;
    server.use(
      http.put(`${BASE}/live`, async ({ request }) => {
        promoted = { body: await request.json(), ifMatch: request.headers.get("if-match") };
        return HttpResponse.json({ live_version: 2, etag: '"e3"' });
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /deploy v2/i }));
    expect(await screen.findByRole("link", { name: /live v2/i })).toBeInTheDocument();
    expect(promoted).toEqual({ body: { version: 2 }, ifMatch: '"e2"' });
    expect(screen.queryByRole("button", { name: /deploy v2/i })).toBeNull();
  });

  it("stale save shows reload dialog", async () => {
    useShellHandlers();
    useCodeHandlers();
    server.use(http.put(`${BASE}/files`, () => apiError(409, "stale")));
    await openEditor();
    pressSave();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/changed elsewhere/i)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /overwrite/i })).toBeInTheDocument();
  });

  it("keeps text typed while a save is in flight", async () => {
    useShellHandlers();
    useCodeHandlers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.put(`${BASE}/files`, async () => {
        await gate;
        return HttpResponse.json({ version: version(2), etag: '"e2"' });
      }),
    );
    const editor = await openEditor();
    await screen.findByRole("button", { name: /save/i });
    const cm = EditorView.findFromDOM(editor);
    if (!cm) throw new Error("no EditorView");
    act(() => cm.dispatch({ changes: { from: 0, insert: "// one\n" } }));
    await screen.findByRole("button", { name: /save \*/i });
    pressSave();
    act(() => cm.dispatch({ changes: { from: 0, insert: "// two\n" } }));
    release();
    expect(await screen.findByText(/saved version 2/i)).toBeInTheDocument();
    expect(cm.state.doc.toString()).toContain("// two");
    expect(cm.state.doc.toString()).toContain("// one");
    // The text typed during the save is still unsaved.
    expect(screen.getByRole("button", { name: /save \*/i })).toBeInTheDocument();
  });

  it("diagnostics from 422 shown inline", async () => {
    useShellHandlers();
    useCodeHandlers();
    server.use(
      http.put(`${BASE}/files`, () =>
        apiError(422, "build_failed", "build failed", {
          details: {
            reason: "type_error",
            message: "build failed",
            version: 3,
            diagnostics: [{ file: "main.ts", line: 1, column: 7, message: "Unexpected token", severity: "error" }],
          },
        }),
      ),
    );
    await openEditor();
    pressSave();
    const list = await screen.findByRole("list", { name: /build problems/i });
    expect(within(list).getByText(/Unexpected token/)).toBeInTheDocument();
    expect(within(list).getByText(/main\.ts:1:7/)).toBeInTheDocument();
  });

  it("wasm version read-only", async () => {
    useShellHandlers();
    useCodeHandlers({ files: { ...files, kind: "wasm", read_only: true, files: { "app.wasm": "(binary)" }, entry: "app.wasm" } });
    renderAt("/acme/apps/hello/code");
    expect(await screen.findByText(/WebAssembly/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("editor chunk not in first-route bundle", () => {
    // CodeMirror may only be imported by the lazily loaded editor modules (cm-*.ts[x]).
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !/^cm-/.test(name)) {
          if (/from\s+["']@codemirror\//.test(readFileSync(p, "utf8"))) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    const page = readFileSync(join(root, "components/features/editor/code-page.tsx"), "utf8");
    expect(page).toMatch(/lazy\(\(\) => import\("\.\/cm-editor"\)\)/);
  });
});
