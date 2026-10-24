// Starter sources uploaded as version 1 (port of internal/apps/templates.go).
// Guest code uses std:* modules only; {{SLUG}} is replaced by the app slug.

export const TEMPLATES: Record<string, string> = {
  "http": `// HTTP handler: every request to /s/<app>/ lands here.
export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return Response.json({ hello: "world", path: url.pathname });
  },
};
`,
  "cron": `// Scheduled job: add a schedule (cron or every N seconds) in the app's Schedules tab.
import { kv } from "std:kv";

export default {
  async scheduled(_event: unknown): Promise<void> {
    await kv.set("last_run", String(Date.now()));
  },
  async fetch(_req: Request): Promise<Response> {
    return Response.json({ last_run: await kv.get("last_run") });
  },
};
`,
  "queue": `// Queue consumer: POST a JSON body to enqueue it; queue() receives batches.
import { enqueue } from "std:queue";

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return Response.json({ ok: true });
    await enqueue("{{SLUG}}", await req.json()); // this app's own queue
    return Response.json({ queued: true }, { status: 202 });
  },
  async queue(batch: { messages: { body: unknown }[] }): Promise<void> {
    for (const m of batch.messages) console.log("message", JSON.stringify(m.body));
  },
};
`,
  "sqlite-crud": `// SQLite CRUD API: GET /items, POST /items {"name": "..."}, DELETE /items/<id>.
import { Database } from "std:sqlite";

const db = new Database();
db.run("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");

export default {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\\/+$/, "");
    const id = Number(path.split("/").pop());
    if (path.endsWith("/items") && req.method === "GET") {
      return Response.json(db.query("SELECT id, name FROM items ORDER BY id").all());
    }
    if (path.endsWith("/items") && req.method === "POST") {
      const { name } = await req.json();
      db.query("INSERT INTO items (name) VALUES (?)").run(String(name));
      return Response.json({ ok: true }, { status: 201 });
    }
    if (req.method === "DELETE" && Number.isInteger(id)) {
      db.query("DELETE FROM items WHERE id = ?").run(id);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};
`,
};

export function renderTemplate(name: string, slug: string): string | undefined {
  const src = TEMPLATES[name];
  return src === undefined ? undefined : src.replaceAll("{{SLUG}}", slug);
}
