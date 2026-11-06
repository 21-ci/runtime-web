import { BellRing, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import {
  useActiveAlerts,
  useChannels,
  useCreateChannel,
  useCreateRule,
  useDeleteChannel,
  useDeleteRule,
  useRules,
  useTestChannel,
  useUpdateChannel,
  useUpdateRule,
  RULE_PARAMS,
  channelFieldMessage,
  testFailure,
  type AlertChannel,
  type AlertRule,
  type ChannelInput,
  type ChannelPatch,
} from "./use-alerts";

type Props = { base: string; kinds: readonly string[]; allowApp: boolean };

/** A refused channel's field errors, in words. Anything else is left to the global toast. */
function channelErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  return Object.fromEntries(Object.entries(err.fieldErrors()).map(([field, code]) => [field, channelFieldMessage(field, code)]));
}

// AlertsPage is one screen for both scopes: base is the API root, kinds what that scope may watch.
export function AlertsPage({ base, kinds, allowApp }: Props) {
  const { t } = useTranslation(["alerts", "platform"]);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={BellRing} entity="admin" title={t("title")} description={t("description")} />
      <ActiveCard base={base} />
      <ChannelsCard base={base} />
      <RulesCard base={base} kinds={kinds} allowApp={allowApp} />
    </div>
  );
}

function ActiveCard({ base }: { base: string }) {
  const { t } = useTranslation(["alerts", "platform"]);
  const active = useActiveAlerts(base);
  const items = active.data?.items;
  return (
    <SectionCard title={t("active.title")}>
      {active.isError ? (
        <QueryError error={active.error} onRetry={() => void active.refetch()} notFoundTitle={t("adminsOnly")} />
      ) : !items ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("active.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {items.map((a) => (
            <li key={`${a.rule_id}:${a.subject}`} className="flex flex-wrap items-center gap-2">
              <Badge>{t(`state.${a.state}`)}</Badge>
              <span>{t(`kinds.${a.kind}`, { defaultValue: a.kind })}</span>
              <span className="font-mono break-all">{a.subject}</span>
              <span className="text-xs text-muted">{formatDateTime(a.since)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function FormSheet(p: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{p.title}</SheetTitle>
          <SheetDescription className="sr-only">{p.title}</SheetDescription>
        </SheetHeader>
        {p.open ? <div className="overflow-y-auto px-4 pb-4">{p.children}</div> : null}
      </SheetContent>
    </Sheet>
  );
}

function ChannelsCard({ base }: { base: string }) {
  const { t } = useTranslation(["alerts", "platform"]);
  const channels = useChannels(base);
  const remove = useDeleteChannel(base);
  const test = useTestChannel(base);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AlertChannel | null>(null);
  const [deleting, setDeleting] = useState<AlertChannel | null>(null);
  const items = channels.data?.items;
  const statusOf = (c: AlertChannel) => {
    if (c.last_error) return t("channels.lastError", { status: c.last_error });
    return c.last_ok_at ? t("channels.lastOk", { at: formatDateTime(c.last_ok_at) }) : t("channels.neverSent");
  };
  return (
    <SectionCard title={t("channels.title")} actions={<Button size="sm" variant="secondary" onClick={() => setAdding(true)}>{t("channels.add")}</Button>}>
      {channels.isError ? (
        <QueryError error={channels.error} onRetry={() => void channels.refetch()} notFoundTitle={t("adminsOnly")} />
      ) : !items ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("channels.none")}</p>
      ) : (
        <Table stack>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.name")}</TableHead>
              <TableHead>{t("fields.kind")}</TableHead>
              <TableHead>{t("channels.status")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.name}</TableCell>
                <TableCell>{t(`channelKinds.${c.kind}`)}</TableCell>
                <TableCell>{statusOf(c)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" disabled={test.isPending} onClick={() => test.mutate(c.id)}>{t("channels.test")}</Button>
                    <Button size="sm" variant="secondary" aria-label={t("platform:alerts.editChannel", { name: c.name })} onClick={() => setEditing(c)}>{t("platform:alerts.edit")}</Button>
                    <Button size="sm" variant="ghost" aria-label={t("channels.delete", { name: c.name })} onClick={() => setDeleting(c)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {test.data && !test.data.ok ? (
        <p role="alert" className="mb-4 break-words rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {testFailure(test.data)}
        </p>
      ) : null}
      <FormSheet open={adding} onOpenChange={setAdding} title={t("channels.add")}>
        <ChannelForm base={base} onDone={() => setAdding(false)} />
      </FormSheet>
      {editing ? <ChannelEdit key={editing.id} base={base} channel={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDelete
        open={deleting !== null}
        title={t("platform:alerts.deleteChannelTitle", { name: deleting?.name })}
        hint={t("platform:alerts.deleteChannelHint")}
        pending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })}
      />
    </SectionCard>
  );
}

function ConfirmDelete(p: { open: boolean; title: string; hint: string; pending: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation(["common", "platform"]);
  return (
    <Dialog open={p.open} onOpenChange={(o) => !o && p.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogDescription>{p.hint}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={p.onCancel}>{t("common:cancel")}</Button>
          <Button variant="danger" disabled={p.pending} onClick={p.onConfirm}>{t("platform:alerts.delete")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Config is write-only: no route returns it. Empty fields keep what is stored, and a new one replaces both at once.
function ChannelEdit({ base, channel, onClose }: { base: string; channel: AlertChannel; onClose: () => void }) {
  const { t } = useTranslation(["alerts", "common", "platform"]);
  const update = useUpdateChannel(base);
  const [name, setName] = useState(channel.name);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const webhook = channel.kind === "webhook";
  const canConfig = channel.kind !== "email";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config = first && second ? (webhook ? { url: first, secret: second } : { bot_token: first, chat_id: second }) : undefined;
    setErrors({});
    update.mutate({ id: channel.id, name, ...(config ? { config } : {}) } as ChannelPatch & { id: string }, { onSuccess: onClose, onError: (err) => setErrors(channelErrors(err)) });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("platform:alerts.editChannel", { name: channel.name })}</DialogTitle>
          <DialogDescription>{t("platform:alerts.configHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field id="edit-channel-name" label={t("fields.name")} value={name} onChange={setName} error={errors.name} />
          {canConfig ? (
            webhook ? (
              <>
                <Field id="edit-url" label={t("fields.url")} value={first} onChange={setFirst} placeholder="https://" optional error={errors["config.url"]} />
                <Field id="edit-secret" label={t("fields.secret")} value={second} onChange={setSecond} type="password" optional error={errors["config.secret"]} />
              </>
            ) : (
              <>
                <Field id="edit-bot-token" label={t("fields.botToken")} value={first} onChange={setFirst} type="password" optional error={errors["config.bot_token"]} />
                <Field id="edit-chat-id" label={t("fields.chatId")} value={second} onChange={setSecond} optional error={errors["config.chat_id"]} />
              </>
            )
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t("common:cancel")}</Button>
            <Button type="submit" disabled={update.isPending}>{t("platform:alerts.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const MUTE_HOURS = [1, 24, 168];

function RuleEdit({ base, rule, channels, onClose }: { base: string; rule: AlertRule; channels: AlertChannel[]; onClose: () => void }) {
  const { t } = useTranslation(["alerts", "common", "platform"]);
  const update = useUpdateRule(base);
  const specs = RULE_PARAMS[rule.kind] ?? [];
  const [params, setParams] = useState<Record<string, string>>(Object.fromEntries(specs.map((s) => [s.key, String(rule.params[s.key] ?? s.fallback)])));
  const [picked, setPicked] = useState<string[]>(rule.channels);
  const [forS, setForS] = useState(String(rule.for_s));
  const [repeatS, setRepeatS] = useState(String(rule.repeat_s));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate(
      { id: rule.id, channels: picked, for_s: Number(forS), repeat_s: Number(repeatS), ...(specs.length ? { params: Object.fromEntries(specs.map((s) => [s.key, Number(params[s.key])])) } : {}) },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("platform:alerts.editRule", { kind: t(`kinds.${rule.kind}`, { defaultValue: rule.kind }) })}</DialogTitle>
          <DialogDescription>{t("platform:alerts.editRuleHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {specs.map((s) => (
            <div key={s.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`param-${s.key}`}>{t(`platform:alerts.params.${s.key}`, { defaultValue: s.key })}</Label>
              <Input id={`param-${s.key}`} type="number" min={s.min} max={s.max} step={s.step ?? 1} required value={params[s.key] ?? ""} onChange={(e) => setParams({ ...params, [s.key]: e.target.value })} />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-for">{t("platform:alerts.forS")}</Label>
            <Input id="rule-for" type="number" min={0} required value={forS} onChange={(e) => setForS(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rule-repeat">{t("platform:alerts.repeatS")}</Label>
            <Input id="rule-repeat" type="number" min={0} required value={repeatS} onChange={(e) => setRepeatS(e.target.value)} />
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[13px] font-medium">{t("rules.channels")}</legend>
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                {c.name}
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t("common:cancel")}</Button>
            <Button type="submit" disabled={update.isPending || picked.length === 0}>{t("platform:alerts.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChannelForm({ base, onDone }: { base: string; onDone: () => void }) {
  const { t } = useTranslation(["alerts", "platform", "operator"]);
  const create = useCreateChannel(base);
  const [kind, setKind] = useState<ChannelInput["kind"]>("webhook");
  const [name, setName] = useState("");
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const webhook = kind === "webhook";
  const firstKey = webhook ? "config.url" : "config.bot_token";
  const secondKey = webhook ? "config.secret" : "config.chat_id";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (!name.trim()) missing.name = t("operator:alerts.required");
    if (!first.trim()) missing[firstKey] = t("operator:alerts.required");
    if (!second.trim()) missing[secondKey] = t("operator:alerts.required");
    setErrors(missing);
    if (Object.keys(missing).length > 0) return;
    const input: ChannelInput = webhook
      ? { kind, name, config: { url: first, secret: second } }
      : { kind, name, config: { bot_token: first, chat_id: second } };
    create.mutate(input, {
      onSuccess: onDone,
      onError: (err) => setErrors(channelErrors(err)),
    });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="alert-channel-kind">{t("fields.kind")}</Label>
        <Select value={kind} onValueChange={(v) => { setKind(v as ChannelInput["kind"]); setFirst(""); setSecond(""); setErrors({}); }}>
          <SelectTrigger id="alert-channel-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="webhook">{t("channelKinds.webhook")}</SelectItem>
            <SelectItem value="telegram">{t("channelKinds.telegram")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Field id="alert-channel-name" label={t("fields.name")} value={name} onChange={setName} error={errors.name} />
      {webhook ? (
        <>
          <Field id="alert-url" label={t("fields.url")} hint={t("fields.urlHint")} value={first} onChange={setFirst} placeholder="https://" error={errors[firstKey]} />
          <Field id="alert-secret" label={t("fields.secret")} hint={t("fields.secretHint")} value={second} onChange={setSecond} type="password" error={errors[secondKey]} />
        </>
      ) : (
        <>
          <Field id="alert-bot-token" label={t("fields.botToken")} value={first} onChange={setFirst} type="password" error={errors[firstKey]} />
          <Field id="alert-chat-id" label={t("fields.chatId")} value={second} onChange={setSecond} error={errors[secondKey]} />
        </>
      )}
      <div><Button type="submit" disabled={create.isPending}>{t("channels.add")}</Button></div>
    </form>
  );
}

function RulesCard({ base, kinds, allowApp }: Props) {
  const { t } = useTranslation(["alerts", "platform"]);
  const rules = useRules(base);
  const channels = useChannels(base);
  const update = useUpdateRule(base);
  const remove = useDeleteRule(base);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  // Fixed when the list loads: a mute running out while the page is open shows at the next load.
  const [now] = useState(() => Date.now());
  const muted = (r: AlertRule) => r.muted_until !== null && r.muted_until > (rules.dataUpdatedAt || now);
  const items = rules.data?.items;
  const nameOf = (id: string) => channels.data?.items.find((c) => c.id === id)?.name ?? id;
  return (
    <SectionCard
      title={t("rules.title")}
      actions={<Button size="sm" variant="secondary" disabled={!channels.data?.items.length} onClick={() => setAdding(true)}>{t("rules.add")}</Button>}
    >
      {rules.isError ? (
        <QueryError error={rules.error} onRetry={() => void rules.refetch()} notFoundTitle={t("adminsOnly")} />
      ) : !items ? (
        <Skeleton className="h-16 w-full" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted">{t("rules.none")}</p>
      ) : (
        <Table stack>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.kind")}</TableHead>
              <TableHead>{t("fields.app")}</TableHead>
              <TableHead>{t("rules.channels")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{t(`kinds.${r.kind}`, { defaultValue: r.kind })}</TableCell>
                <TableCell>{r.app ?? t("rules.allApps")}</TableCell>
                <TableCell>
                  {r.channels.map(nameOf).join(", ")}
                  {muted(r) ? <span className="block text-xs text-muted">{t("platform:alerts.mutedUntil", { at: formatDateTime(r.muted_until ?? 0) })}</span> : null}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ id: r.id, enabled: !r.enabled })}>
                      {r.enabled ? t("rules.disable") : t("rules.enable")}
                    </Button>
                    {muted(r) ? (
                      <Button size="sm" variant="secondary" disabled={update.isPending} onClick={() => update.mutate({ id: r.id, muted_until: null })}>{t("platform:alerts.unmute")}</Button>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="secondary" disabled={update.isPending}>{t("platform:alerts.mute")}</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {MUTE_HOURS.map((h) => (
                            <DropdownMenuItem key={h} onSelect={() => update.mutate({ id: r.id, muted_until: Date.now() + h * 3_600_000 })}>
                              {t("platform:alerts.muteFor", { hours: h })}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>{t("platform:alerts.edit")}</Button>
                    <Button size="sm" variant="ghost" aria-label={t("rules.delete")} onClick={() => setDeleting(r)}>
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {channels.data && channels.data.items.length === 0 ? <p className="mt-2 text-sm text-muted">{t("rules.needChannel")}</p> : null}
      <FormSheet open={adding} onOpenChange={setAdding} title={t("rules.add")}>
        <RuleForm base={base} kinds={kinds} allowApp={allowApp} channels={channels.data?.items ?? []} onDone={() => setAdding(false)} />
      </FormSheet>
      {editing ? <RuleEdit key={editing.id} base={base} rule={editing} channels={channels.data?.items ?? []} onClose={() => setEditing(null)} /> : null}
      <ConfirmDelete
        open={deleting !== null}
        title={t("platform:alerts.deleteRuleTitle")}
        hint={t("platform:alerts.deleteRuleHint")}
        pending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })}
      />
    </SectionCard>
  );
}

function RuleForm({ base, kinds, allowApp, channels, onDone }: Props & { channels: AlertChannel[]; onDone: () => void }) {
  const { t } = useTranslation(["alerts", "platform"]);
  const create = useCreateRule(base);
  const [kind, setKind] = useState(kinds[0] ?? "");
  const [picked, setPicked] = useState("");
  const [app, setApp] = useState("");
  const channel = picked || channels[0]?.id || "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ kind, channels: [channel], ...(allowApp && app ? { app } : {}) }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="alert-rule-kind">{t("fields.kind")}</Label>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger id="alert-rule-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            {kinds.map((k) => <SelectItem key={k} value={k}>{t(`kinds.${k}`, { defaultValue: k })}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="alert-rule-channel">{t("rules.channels")}</Label>
        <Select value={channel} onValueChange={setPicked}>
          <SelectTrigger id="alert-rule-channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            {channels.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {allowApp ? <Field id="alert-rule-app" label={t("fields.app")} hint={t("fields.appHint")} value={app} onChange={setApp} optional /> : null}
      <div><Button type="submit" disabled={create.isPending}>{t("rules.add")}</Button></div>
    </form>
  );
}

function Field(p: { id: string; label: string; hint?: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; optional?: boolean; error?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={p.id}>{p.label}</Label>
      <Input
        id={p.id}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        autoComplete="off"
        required={!p.optional}
        {...(p.error ? { "aria-invalid": true, "aria-describedby": `${p.id}-error` } : {})}
        {...(p.placeholder ? { placeholder: p.placeholder } : {})}
        {...(p.type ? { type: p.type } : {})}
      />
      {p.hint ? <p className="text-xs text-muted">{p.hint}</p> : null}
      {p.error ? <p id={`${p.id}-error`} role="alert" className="text-sm text-danger-text">{p.error}</p> : null}
    </div>
  );
}
