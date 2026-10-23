// TS language worker: type-checks the app's files against the ES/DOM libs and the std:* stubs.
import ts from "typescript";

export type WorkerRequest = { id: number; path: string; files: Record<string, string> };
export type TsDiagnostic = { from: number; to: number; message: string; severity: "error" | "warning" };

const libs = mapNames(
  import.meta.glob(
    [
      "/node_modules/typescript/lib/lib.es5.d.ts",
      "/node_modules/typescript/lib/lib.es20*.d.ts",
      "/node_modules/typescript/lib/lib.dom*.d.ts",
      "/node_modules/typescript/lib/lib.decorators*.d.ts",
    ],
    { query: "?raw", import: "default", eager: true },
  ) as Record<string, string>,
  "/lib/",
);
const stubs = mapNames(
  import.meta.glob("../../../lib/std-types/*.d.ts", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >,
  "/std/",
);

function mapNames(m: Record<string, string>, dir: string): Map<string, string> {
  return new Map(Object.entries(m).map(([k, v]) => [dir + k.slice(k.lastIndexOf("/") + 1), v]));
}

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  noEmit: true,
  allowJs: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: [],
};

const user = new Map<string, string>();
const versions = new Map<string, number>();

function read(f: string): string | undefined {
  return user.get(f) ?? libs.get(f) ?? stubs.get(f);
}

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => [...stubs.keys(), ...user.keys()],
  getScriptVersion: (f) => String(versions.get(f) ?? 0),
  getScriptSnapshot: (f) => {
    const t = read(f);
    return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t);
  },
  getCurrentDirectory: () => "/app",
  getCompilationSettings: () => options,
  getDefaultLibFileName: () => "/lib/lib.d.ts",
  fileExists: (f) => read(f) !== undefined,
  readFile: read,
  readDirectory: () => [],
  directoryExists: () => true,
  getDirectories: () => [],
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

// The app tsconfig uses the DOM lib, so describe the worker scope by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (e) => {
  const { id, path, files } = e.data;
  const next = new Map(Object.entries(files).map(([p, t]) => [`/app/${p}`, t]));
  for (const k of [...user.keys()]) if (!next.has(k)) user.delete(k);
  for (const [k, t] of next) {
    if (user.get(k) !== t) {
      user.set(k, t);
      versions.set(k, (versions.get(k) ?? 0) + 1);
    }
  }
  const file = `/app/${path}`;
  let diagnostics: TsDiagnostic[] = [];
  try {
    diagnostics = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map((d) => ({
      from: d.start ?? 0,
      to: (d.start ?? 0) + (d.length ?? 0),
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    }));
  } catch {
    // A checker crash must not break editing; report nothing for this pass.
  }
  scope.postMessage({ id, diagnostics });
};
