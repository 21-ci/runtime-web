import { Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { useAppDetail } from "@/components/features/versions/use-versions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCan } from "@/hooks/authz";
import { PreviewsCard } from "./previews";
import { formatDateTime } from "@/lib/format";

import {
  type GitDelivery,
  type GitLink,
  type GitLinkCreated,
  type GitLinkInput,
  type GitRule,
  useCreateGitLink,
  useDeleteGitLink,
  useGit,
  usePutGitRules,
  useUpdateGitLink,
} from "./use-git";

const STATE_VARIANT: Record<GitDelivery["state"], "success" | "danger" | "warning" | "outline"> = {
  queued: "warning",
  resolving: "warning",
  building: "warning",
  deployed: "success",
  skipped: "outline",
  failed: "danger",
};

// GitSettings manages an app's repository link. The server allows this to project admins only; the
// section is hidden from everyone else rather than shown disabled, since none of it is theirs to read.
export function GitSettings({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation(["git", "branches"]);
  const detail = useAppDetail(org, app);
  const allowed = useCan(org, detail.data?.project)("app.git.manage") === true;
  const git = useGit(org, app, allowed);
  const [created, setCreated] = useState<GitLinkCreated | null>(null);

  if (!allowed) return null;
  if (git.isError) {
    return <QueryError error={git.error} onRetry={() => void git.refetch()} notFoundTitle={t("branches:notFound")} notFoundDescription={t("branches:notFoundDescription")} />;
  }
  if (git.isPending) return <Skeleton className="h-40 w-full" />;
  const { link, rules, deliveries } = git.data;

  return (
    <SectionCard title={t("title")} description={t("description")}>
      <div className="flex flex-col gap-6 px-5 pb-5">
        {link ? (
          <>
            <LinkSummary org={org} app={app} link={link} />
            <RulesEditor key={JSON.stringify(rules)} org={org} app={app} rules={rules} />
            <Deliveries items={deliveries} />
            <PreviewsToggle org={org} app={app} project={detail.data?.project} enabled={link.previews === true} />
          </>
        ) : (
          <LinkForm org={org} app={app} onCreated={setCreated} />
        )}
      </div>
      {created ? <SecretDialog created={created} onClose={() => setCreated(null)} /> : null}
    </SectionCard>
  );
}

function LinkForm({ org, app, onCreated }: { org: string; app: string; onCreated: (c: GitLinkCreated) => void }) {
  const { t } = useTranslation("git");
  const create = useCreateGitLink(org, app);
  const [provider, setProvider] = useState<GitLinkInput["provider"]>("github");
  const [baseUrl, setBaseUrl] = useState("https://github.com");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [subdir, setSubdir] = useState("");
  const [token, setToken] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { provider, base_url: baseUrl, repo, branch, auto_promote: true, ...(subdir ? { subdir } : {}), ...(token ? { token } : {}) },
      { onSuccess: onCreated },
    );
  };

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-4">
      <p className="text-sm text-muted">{t("empty")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="git-provider">{t("provider")}</Label>
        <Select value={provider} onValueChange={(v) => setProvider(v as GitLinkInput["provider"])}>
          <SelectTrigger id="git-provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="github">GitHub</SelectItem>
            <SelectItem value="gitlab">GitLab</SelectItem>
            <SelectItem value="gitea">Gitea</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Field id="git-base" label={t("baseUrl")} hint={t("baseUrlHint")} value={baseUrl} onChange={setBaseUrl} required />
      <Field id="git-repo" label={t("repo")} value={repo} onChange={setRepo} placeholder="owner/name" required />
      <Field id="git-branch" label={t("branch")} value={branch} onChange={setBranch} required />
      <Field id="git-subdir" label={t("subdir")} value={subdir} onChange={setSubdir} />
      <Field id="git-token" label={t("token")} hint={t("tokenHint")} value={token} onChange={setToken} type="password" />
      <div><Button type="submit" disabled={create.isPending}>{t("create")}</Button></div>
    </form>
  );
}

function Field(p: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; required?: boolean; placeholder?: string; type?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={p.id}>{p.label}</Label>
      <Input
        id={p.id}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        autoComplete="off"
        {...(p.required ? { required: true } : {})}
        {...(p.placeholder ? { placeholder: p.placeholder } : {})}
        {...(p.type ? { type: p.type } : {})}
      />
      {p.hint ? <p className="text-xs text-muted">{p.hint}</p> : null}
    </div>
  );
}

function SecretDialog({ created, onClose }: { created: GitLinkCreated; onClose: () => void }) {
  const { t } = useTranslation("git");
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("secretTitle")}</DialogTitle>
          <DialogDescription>{t("secretHint")}</DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2 text-sm">
          <dt className="font-medium">{t("webhookUrl")}</dt>
          <dd className="break-all font-mono">{created.webhook_url}</dd>
          <dt className="font-medium">{t("secret")}</dt>
          <dd className="break-all font-mono">{created.hook_secret}</dd>
        </dl>
        <DialogFooter><Button onClick={onClose}>{t("done")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewsToggle({ org, app, project, enabled }: { org: string; app: string; project: string | undefined; enabled: boolean }) {
  const update = useUpdateGitLink(org, app);
  return <PreviewsCard org={org} app={app} project={project} enabled={enabled} toggling={update.isPending} onToggle={(previews) => update.mutate({ previews })} />;
}

function LinkSummary({ org, app, link }: { org: string; app: string; link: GitLink }) {
  const { t } = useTranslation("git");
  const update = useUpdateGitLink(org, app);
  const remove = useDeleteGitLink(org, app);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-mono">{link.repo}</span>
        <span className="text-muted">{link.base_url}</span>
        <span className="font-mono text-muted">{link.branch}</span>
        {link.paused ? <Badge variant="warning">{t("paused")}</Badge> : null}
        <span className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setConfirm(true)}>{t("unlink")}</Button>
      </div>
      <p className="break-all font-mono text-xs text-muted">{link.webhook_url}</p>
      {link.paused ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="flex-1">{t("pausedHint")}</p>
          <Button size="sm" variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ paused: false })}>{t("resume")}</Button>
        </div>
      ) : null}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={t("unlinkConfirm")} description={t("unlinkDescription")} confirmLabel={t("unlink")} onConfirm={() => remove.mutate(undefined)} />
    </div>
  );
}

function RulesEditor({ org, app, rules }: { org: string; app: string; rules: GitRule[] }) {
  const { t } = useTranslation("git");
  const put = usePutGitRules(org, app);
  const [draft, setDraft] = useState(rules);
  const change = (i: number, patch: Partial<GitRule>) => setDraft(draft.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t("rules")}</h3>
        <p className="text-xs text-muted">{t("rulesHint")}</p>
      </div>
      {draft.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-3">
          <Input aria-label={t("pattern")} placeholder="feature/*" className="w-48" value={r.ref_pattern} onChange={(e) => change(i, { ref_pattern: e.target.value })} />
          <Input aria-label={t("branchName")} placeholder="staging" className="w-40" value={r.branch_name} onChange={(e) => change(i, { branch_name: e.target.value })} />
          <label className="flex items-center gap-2 text-sm" title={t("autoSwitchHint")}>
            <input type="checkbox" checked={r.auto_switch} onChange={(e) => change(i, { auto_switch: e.target.checked })} />
            {t("autoSwitch")}
          </label>
          {r.paused ? (
            <>
              <Badge variant="warning">{t("paused")}</Badge>
              <Button size="sm" variant="secondary" onClick={() => change(i, { paused: false })}>{t("resume")}</Button>
            </>
          ) : null}
          <Button size="icon" variant="ghost" aria-label={t("removeRule", { pattern: r.ref_pattern })} onClick={() => setDraft(draft.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      {draft.some((r) => r.auto_switch) ? <p className="text-xs text-muted">{t("autoSwitchHint")}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setDraft([...draft, { ref_pattern: "", branch_name: "", auto_switch: false, paused: false }])}>{t("addRule")}</Button>
        <Button size="sm" disabled={put.isPending} onClick={() => put.mutate(draft)}>{t("saveRules")}</Button>
      </div>
    </div>
  );
}

function Deliveries({ items }: { items: GitDelivery[] }) {
  const { t } = useTranslation("git");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("deliveries")}</h3>
      {items.length === 0 ? <p className="text-sm text-muted">{t("noDeliveries")}</p> : null}
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((d) => (
          <li key={`${d.ref}:${d.sha}`} className="flex flex-wrap items-center gap-3">
            <Badge variant={STATE_VARIANT[d.state]}>{t(`state.${d.state}`)}</Badge>
            <span className="font-mono">{(d.head_sha ?? d.sha).slice(0, 12)}</span>
            <span className="text-muted">{d.ref.replace(/^refs\/heads\//, "")}</span>
            {d.error ? <span className="font-mono text-xs text-muted">{d.error}</span> : null}
            <span className="text-xs text-muted">{formatDateTime(d.received_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
