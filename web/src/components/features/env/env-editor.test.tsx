import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { EnvEditor, parseEnvText, toEnvText } from "./env-editor";

const BASE = "/api/orgs/acme/apps/hello/env";

function useEnvHandlers(initial: Record<string, string>) {
  let env = { ...initial };
  const puts: Record<string, string>[] = [];
  server.use(
    http.get(BASE, () => HttpResponse.json({ env })),
    http.put(BASE, async ({ request }) => {
      const body = (await request.json()) as { env: Record<string, string> };
      env = body.env;
      puts.push(body.env);
      return HttpResponse.json({ env });
    }),
  );
  return puts;
}

function renderEditor(canWrite = true) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <EnvEditor org="acme" app="hello" canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

describe("env text helpers", () => {
  it("round-trips a map through KEY=VALUE lines", () => {
    const text = toEnvText({ B: "2", A: "x=y" });
    expect(text).toBe("A=x=y\nB=2");
    expect(parseEnvText(`# comment\n\n${text}`)).toEqual({ env: { A: "x=y", B: "2" } });
  });

  it("names the first bad line", () => {
    expect(parseEnvText("OK=1\n1BAD=2")).toEqual({ error: "Line 2: use KEY=VALUE with a valid name." });
  });
});

describe("EnvEditor", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists variables masked, reveals a value and copies the key", async () => {
    useEnvHandlers({ MODE: "prod" });
    renderEditor();
    expect(await screen.findByText("MODE")).toBeInTheDocument();
    expect(screen.getByText("••••••••")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show value of MODE" }));
    expect(screen.getByText("prod")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide value of MODE" })).toBeInTheDocument();
  });

  it("adds a variable through the dialog and saves the whole map", async () => {
    const puts = useEnvHandlers({ MODE: "prod" });
    renderEditor();
    await screen.findByText("MODE");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: "Add variable" });
    await userEvent.type(within(dialog).getByLabelText("Key"), "REGION");
    await userEvent.type(within(dialog).getByLabelText("Value"), "eu");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save variable" }));
    await waitFor(() => expect(puts).toEqual([{ MODE: "prod", REGION: "eu" }]));
    expect(await screen.findByText("REGION")).toBeInTheDocument();
  });

  it("rejects an invalid key before saving", async () => {
    const puts = useEnvHandlers({});
    renderEditor();
    await userEvent.click(await screen.findByRole("button", { name: "Add variable" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Key"), "1bad");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save variable" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/letters, digits and underscores/);
    expect(puts).toEqual([]);
  });

  it("deletes a variable after confirmation", async () => {
    const puts = useEnvHandlers({ MODE: "prod", REGION: "eu" });
    renderEditor();
    await screen.findByText("REGION");
    await userEvent.click(screen.getByRole("button", { name: "Delete REGION" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete variable" }));
    await waitFor(() => expect(puts).toEqual([{ MODE: "prod" }]));
  });

  it("edits the raw .env text and returns to the table", async () => {
    const puts = useEnvHandlers({ MODE: "prod" });
    renderEditor();
    await screen.findByText("MODE");
    await userEvent.click(screen.getByRole("button", { name: "Edit as .env" }));
    const area = screen.getByRole("textbox", { name: "Environment variables" });
    await userEvent.clear(area);
    await userEvent.type(area, "MODE=dev{enter}DEBUG=1");
    await userEvent.click(screen.getByRole("button", { name: "Save variables" }));
    await waitFor(() => expect(puts).toEqual([{ MODE: "dev", DEBUG: "1" }]));
    expect(await screen.findByText("DEBUG")).toBeInTheDocument();
  });

  it("imports a .env file and merges it", async () => {
    const puts = useEnvHandlers({ MODE: "prod" });
    renderEditor();
    await screen.findByText("MODE");
    const file = new File(["REGION=eu\n# note\n"], "app.env", { type: "text/plain" });
    await userEvent.upload(screen.getByLabelText("Import .env file"), file);
    await waitFor(() => expect(puts).toEqual([{ MODE: "prod", REGION: "eu" }]));
  });

  it("exports the variables as a .env download", async () => {
    useEnvHandlers({ MODE: "prod" });
    renderEditor();
    await screen.findByText("MODE");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await userEvent.click(screen.getByRole("button", { name: "Export .env" }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("hides every write control for read-only roles", async () => {
    useEnvHandlers({ MODE: "prod" });
    renderEditor(false);
    await screen.findByText("MODE");
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import .env" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit MODE" })).toBeNull();
    expect(screen.getByRole("button", { name: "Export .env" })).toBeInTheDocument();
  });
});
