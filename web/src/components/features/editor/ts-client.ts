import type { TsDiagnostic } from "./ts-worker";

// One shared TS worker, started on first use. Without Worker support (tests) checks are skipped.
let worker: Worker | null | undefined;
let seq = 0;
const pending = new Map<number, (d: TsDiagnostic[]) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") return (worker = null);
  worker = new Worker(new URL("./ts-worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (e: MessageEvent<{ id: number; diagnostics: TsDiagnostic[] }>) => {
    pending.get(e.data.id)?.(e.data.diagnostics);
    pending.delete(e.data.id);
  });
  return worker;
}

export function tsDiagnostics(path: string, files: Record<string, string>): Promise<TsDiagnostic[]> {
  if (!/\.(ts|tsx|js|jsx|mts|mjs)$/.test(path)) return Promise.resolve([]);
  const w = getWorker();
  if (!w) return Promise.resolve([]);
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    w.postMessage({ id, path, files });
  });
}
