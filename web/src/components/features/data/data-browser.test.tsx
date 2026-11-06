import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createQueryClient } from "@/lib/query";
import { server } from "@/test/msw";

import { browseSql, cellText, DataBrowser, quoteIdent, severalStatements, timestampHint, toCsv } from "./data-browser";

const HOSTILE = '<img src=x onerror=alert(1)>';

function setup(
  role: "owner" | "member",
  query: () => Response = () => HttpResponse.json({ columns: ["id"], rows: [[HOSTILE]], truncated: true, elapsed_ms: 2 }),
  blobs: unknown[] = [{ key: "b1", size: 3, content_type: "text/plain" }],
) {
  const sent: unknown[] = [];
  server.use(
    http.get("/api/me", () => HttpResponse.json({ user: { id: "usr_1", instance_admin: false } })),
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ id: "org_1", slug: "acme", name: "Acme", created_at: 1, role }] })),
    http.get("/api/orgs/:org/projects", () => HttpResponse.json({ items: [{ slug: "web", name: "Web", role: "developer", environments: [] }] })),
    http.get("/api/orgs/:org/apps/:app/data/tables", () => HttpResponse.json({ items: [{ name: "users", type: "table", columns: [{ name: "id", type: "INTEGER", pk: 1 }], rows_estimate: 2 }] })),
    http.get("/api/orgs/:org/apps/:app/data/kv", () => HttpResponse.json({ items: [{ key: "k1", key_b64: "azE", type: "text", size: 1, expires_at: null, preview: "v" }], next_cursor: null })),
    http.get("/api/orgs/:org/apps/:app/data/kv/:key", () => HttpResponse.json({ key: "k1", type: "text", size: 1, value: "full-value", truncated: false })),
    http.get("/api/orgs/:org/apps/:app/data/blobs", () => HttpResponse.json({ items: blobs, next_cursor: null })),
    http.post("/api/orgs/:org/apps/:app/data/query", async ({ request }) => {
      sent.push(await request.json());
      return query();
    }),
  );
  render(<QueryClientProvider client={createQueryClient()}><DataBrowser org="acme" app="hello" project="web" /></QueryClientProvider>);
  return sent;
}

afterEach(cleanup);

describe("generated SQL", () => {
  it("quotes hostile names", () => {
    expect(quoteIdent('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    const t = { name: 'x"y', columns: [{ name: 'p"k', type: "TEXT", pk: 1 }] };
    expect(browseSql(t, undefined).sql).toBe('SELECT * FROM "x""y" ORDER BY "p""k" LIMIT 100');
  });

  it("pages by key with the value as an argument, never in the text", () => {
    const out = browseSql({ name: "t", columns: [{ name: "id", type: "INTEGER", pk: 1 }] }, "1 OR 1=1");
    expect(out.sql).toContain("> ?1");
    expect(out.sql).not.toContain("1=1");
    expect(out.args).toEqual(["1 OR 1=1"]);
  });
});

describe("cellText", () => {
  it("renders the runtime's encoded forms", () => {
    expect(cellText(null)).toBe("NULL");
    expect(cellText({ $blob: 3, hex: "aabb" })).toBe("BLOB(3) aabb");
    expect(cellText({ $text: "abc", size: 9, truncated: true })).toBe("abc…");
    expect(cellText(5)).toBe("5");
  });
});

describe("result helpers", () => {
  it("counts statements, ignoring a trailing semicolon, strings and comments", () => {
    expect(severalStatements("select 1;")).toBe(false);
    expect(severalStatements("select ';' -- a;b\n, \"x;y\" /* ; */")).toBe(false);
    expect(severalStatements("select 1; select 2")).toBe(true);
  });

  it("writes CSV that a spreadsheet will not run", () => {
    expect(toCsv({ columns: ["a", "b,c"], rows: [['x"y', "=1+1"], [null, 5]], truncated: false, elapsed_ms: 0 })).toBe(
      'a,"b,c"\r\n"x""y",\'=1+1\r\nNULL,5\r\n',
    );
  });

  it("reads a date only from values that can be one", () => {
    expect(timestampHint("n", 5)).toBeNull();
    expect(timestampHint("n", 1_700_000_000_000)).toContain("2023-11-14");
    expect(timestampHint("n", 1_700_000_000)).toBeNull();
    expect(timestampHint("updated_at", 1_700_000_000)).toContain("2023-11-14");
  });
});

describe("DataBrowser", () => {
  it("is refused to a non-admin without a call", async () => {
    setup("member");
    expect(await screen.findByText("Project admins only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("shows query results as text, never markup", async () => {
    const sent = setup("owner");
    fireEvent.change(await screen.findByLabelText("SQL"), { target: { value: "SELECT 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText(HOSTILE)).toBeInTheDocument();
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(sent).toEqual([{ sql: "SELECT 1" }]);
    expect(screen.getByText(/cut short/)).toBeInTheDocument();
  });

  it("shows a refused statement's message", async () => {
    setup("owner", () => HttpResponse.json({ error: { code: "sql_not_readonly", message: "no" } }, { status: 422 }));
    fireEvent.change(await screen.findByLabelText("SQL"), { target: { value: "DROP TABLE x" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/only reads/i);
  });

  it("says two statements are the problem when they are", async () => {
    setup("owner", () => HttpResponse.json({ error: { code: "sql_not_readonly", message: "sql not readonly" } }, { status: 422 }));
    fireEvent.change(await screen.findByLabelText("SQL"), { target: { value: "select 1; select 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/one statement/i);
  });

  it("shows duplicate columns apart, a date on hover and a CSV export", async () => {
    setup("owner", () => HttpResponse.json({ columns: ["a", "a", "created_at"], rows: [[1, 2, 1_700_000_000_000]], truncated: false, elapsed_ms: 1 }));
    fireEvent.change(await screen.findByLabelText("SQL"), { target: { value: "select" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("columnheader", { name: "a (2)" })).toBeInTheDocument();
    expect(screen.getByText("1700000000000")).toHaveAttribute("title", expect.stringContaining("2023-11-14T22:13:20.000Z"));
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  });

  it("shows 200 rows of a long result, then the rest on request", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i]);
    setup("owner", () => HttpResponse.json({ columns: ["n"], rows, truncated: false, elapsed_ms: 1 }));
    fireEvent.change(await screen.findByLabelText("SQL"), { target: { value: "select" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Showing 200 of 250 rows.")).toBeInTheDocument();
    expect(screen.queryByText("200")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("249")).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });

  it("names an empty file list and offers the SQLite export", async () => {
    setup("owner", undefined, []);
    expect(await screen.findByText("No files yet")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Export data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("browses a table and reads a key", async () => {
    const sent = setup("owner");
    fireEvent.click(await screen.findByRole("button", { name: /users/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ sql: 'SELECT * FROM "users" ORDER BY "id" LIMIT 100' });
    fireEvent.click(await screen.findByRole("button", { name: "k1" }));
    expect(await screen.findByText("full-value")).toBeInTheDocument();
    expect(await screen.findByText(/b1/)).toBeInTheDocument();
  });
});
