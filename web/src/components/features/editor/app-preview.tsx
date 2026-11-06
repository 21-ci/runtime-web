import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PreviewFrame } from "@/components/ui/preview-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { UrlBar } from "@/components/ui/url-bar";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type PreviewResponse = { status: number; needs_key?: boolean; content_type: string | null; body: string | null; truncated: boolean };

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
// Past this the colours cost more than they give.
const MAX_HIGHLIGHT = 64 * 1024;

/** Spans for pretty JSON text. Always React text nodes: a response body never becomes markup. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const isString = m[1] !== undefined;
    const cls = m[2] ? "text-tag-blue-text" : isString ? "text-tag-green-text" : /\d/.test(m[0]) ? "text-tag-orange-text" : "text-tag-purple-text";
    const token = m[1] ?? m[0];
    out.push(<span key={m.index} className={cls}>{token}</span>);
    if (m[2]) out.push(m[2]);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Text the console can show itself. HTML, a redirect or a binary body is the browser's to render. */
function isText(r: PreviewResponse): r is PreviewResponse & { body: string } {
  return r.body !== null && !/html/i.test(r.content_type ?? "") && !(r.status >= 300 && r.status < 400);
}

function ResponseBody({ response, className }: { response: PreviewResponse & { body: string }; className?: string }) {
  const { t } = useTranslation("editor");
  const [pretty, setPretty] = useState(true);
  const parsed = useMemo(() => parseJson(response.body), [response.body]);
  const isJson = parsed !== undefined;
  const text = isJson && pretty ? JSON.stringify(parsed, null, 2) : response.body;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-card", className)}>
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1">
        <Badge variant={response.status < 400 ? "success" : "warning"}>{`HTTP ${response.status}`}</Badge>
        {response.status === 401 ? <span className="text-[12px] text-muted">{t("preview.needsKey")}</span> : null}
        {response.truncated ? <span className="text-[12px] text-muted">{t("preview.truncated")}</span> : null}
        {isJson ? (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <input type="checkbox" role="switch" checked={pretty} onChange={(e) => setPretty(e.target.checked)} className="size-3.5 accent-[var(--accent)]" />
            {t("preview.pretty")}
          </label>
        ) : null}
      </div>
      <pre tabIndex={0} aria-label={t("preview.body")} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-[1.6] text-text outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
        {isJson && pretty && text.length <= MAX_HIGHLIGHT ? highlightJson(text) : text}
      </pre>
    </div>
  );
}

// AppPreview shows what the live app answers, only after a click: a request is real traffic. It counts against usage,
// shows in the metrics and runs whatever the handler does on GET /. `refreshKey` asks again after a deploy, but never
// starts a preview the user did not open.
export function AppPreview({
  org,
  app,
  url,
  title,
  refreshKey = 0,
  className,
  barClassName,
}: {
  org: string;
  app: string;
  url: string;
  title: string;
  refreshKey?: number;
  className?: string;
  barClassName?: string;
}) {
  const { t } = useTranslation("editor");
  const [frameKey, setFrameKey] = useState(0);
  const read = useMutation({
    meta: { skipGlobalError: true },
    mutationFn: () => api.post<PreviewResponse>(`/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/preview`),
  });
  const { mutate, isIdle } = read;
  function load() {
    mutate();
    setFrameKey((k) => k + 1);
  }

  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    if (!isIdle) mutate();
  }, [refreshKey, isIdle, mutate]);

  let body: ReactNode;
  if (read.isIdle) {
    body = (
      <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-line bg-panel p-4 text-center", className)}>
        <Button variant="secondary" size="sm" onClick={load}>
          <Play aria-hidden="true" /> {t("preview.load")}
        </Button>
        <p className="max-w-[46ch] text-[12px] text-muted">{t("preview.loadHint")}</p>
      </div>
    );
  } else if (read.isPending) {
    body = <Skeleton className={cn("w-full rounded-lg", className)} aria-busy="true" />;
  } else if (read.data?.needs_key) {
    body = (
      <div role="status" className={cn("flex flex-col justify-center gap-2 rounded-lg border border-line bg-panel p-4 text-sm", className)}>
        <p>{t("preview.needsKeyClear")}</p>
        <code className="break-all rounded-md bg-canvas-inset p-2 font-mono text-[13px]">{`curl -H "Authorization: Bearer $RT_KEY" ${url}`}</code>
      </div>
    );
  } else if (read.data && isText(read.data)) {
    body = <ResponseBody response={read.data} className={className} />;
  } else {
    // An HTML app, or a console that cannot reach the app from where it runs: the browser can still show it.
    body = <PreviewFrame url={url} title={title} reloadKey={frameKey + refreshKey} className={className} />;
  }

  return (
    <>
      <UrlBar url={url} badge={<Badge variant="success">HTTP</Badge>} onReload={load} className={barClassName} />
      {body}
    </>
  );
}
