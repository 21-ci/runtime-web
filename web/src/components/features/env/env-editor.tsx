import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function appPath(org: string, app: string) {
  return `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;
}

// toEnvText renders the env map as KEY=VALUE lines, sorted by key.
export function toEnvText(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
}

// parseEnvText reads KEY=VALUE lines. Blank lines and # comments are skipped. Returns the map
// or a message naming the first bad line.
export function parseEnvText(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq === -1 ? "" : line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) return { error: `Line ${i + 1}: use KEY=VALUE with a valid name.` };
    env[key] = line.slice(eq + 1);
  }
  return { env };
}

// EnvEditor edits the app's plain environment variables as one complete map (PUT replaces it).
export function EnvEditor({ org, app }: { org: string; app: string }) {
  const qc = useQueryClient();
  const env = useQuery({
    queryKey: ["env", org, app],
    queryFn: () => api.get<{ env: Record<string, string> }>(`${appPath(org, app)}/env`).then((r) => r.env),
  });
  const save = useMutation({
    mutationFn: (body: Record<string, string>) => api.put<{ env: Record<string, string> }>(`${appPath(org, app)}/env`, { env: body }),
    onSuccess: () => {
      toast.success("Environment saved.");
      void qc.invalidateQueries({ queryKey: ["env", org, app] });
    },
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (env.data) setText(toEnvText(env.data));
  }, [env.data]);

  if (env.isError) {
    return <QueryError error={env.error} onRetry={() => void env.refetch()} notFoundTitle="App not found" />;
  }
  if (env.isPending) return <Skeleton className="h-40 w-full" />;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = parseEnvText(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    save.mutate(parsed.env);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-labelledby="env-heading">
      <div>
        <h2 id="env-heading" className="text-sm font-semibold">
          Environment variables
        </h2>
        <p className="text-sm text-muted">One KEY=VALUE per line. Use secrets for anything sensitive.</p>
      </div>
      <label htmlFor="env-text" className="sr-only">
        Environment variables
      </label>
      <textarea
        id="env-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={8}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "env-error" : undefined}
        className="w-full rounded-[8px] border border-line bg-surface p-3 font-mono text-sm text-text focus-visible:outline-2 focus-visible:outline-blue"
      />
      {error ? (
        <p id="env-error" role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={save.isPending}>
          Save variables
        </Button>
      </div>
    </form>
  );
}
