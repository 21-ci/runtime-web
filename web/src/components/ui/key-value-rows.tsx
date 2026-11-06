import { Button } from "./button";
import { Input } from "./input";

// KvRow is one editable pair. `locked` rows hold a nested value the editor does not model (shown
// as read-only JSON text and sent back as they were), so nothing the form cannot edit is lost.
export type KvRow = { key: string; value: string; locked?: unknown };

export type KvMessages = {
  keyRequired: string;
  valueRequired: string;
  duplicateKey: string;
};

// rowsFromObject turns a stored object into rows. Scalars become text; nested values are locked.
export function rowsFromObject(obj: Record<string, unknown>): KvRow[] {
  return Object.entries(obj).map(([key, v]) => {
    if (v !== null && typeof v === "object") return { key, value: JSON.stringify(v), locked: v };
    return { key, value: v === null || v === undefined ? "null" : String(v) };
  });
}

// parseScalar reads a typed value: true, false, null, a number, or else the text as it is.
export function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

// objectFromRows builds the object to send. Rows with neither key nor value are skipped, so an
// empty row never blocks a save. Other rows must have a key, and keys must be unique; a value is
// required unless `allowEmpty`. Errors come back per row index. `typed` reads values with
// parseScalar, else keeps them as text.
export function objectFromRows(
  rows: KvRow[],
  messages: KvMessages,
  { typed = true, allowEmpty = false }: { typed?: boolean; allowEmpty?: boolean } = {},
): { value: Record<string, unknown> } | { errors: Record<number, string> } {
  const value: Record<string, unknown> = {};
  const errors: Record<number, string> = {};
  rows.forEach((r, i) => {
    const key = r.key.trim();
    if (key === "" && r.value.trim() === "" && r.locked === undefined) return;
    if (key === "") {
      errors[i] = messages.keyRequired;
      return;
    }
    if (r.locked === undefined && !allowEmpty && r.value.trim() === "") {
      errors[i] = messages.valueRequired;
      return;
    }
    if (key in value) {
      errors[i] = messages.duplicateKey;
      return;
    }
    if (r.locked !== undefined) value[key] = r.locked;
    else value[key] = typed ? parseScalar(r.value) : r.value;
  });
  return Object.keys(errors).length > 0 ? { errors } : { value };
}

export type KvLabels = {
  key: string;
  value: string;
  add: string;
  remove: (key: string) => string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
};

// KeyValueRows edits pairs as one row each, with Add and Remove. Each row shows its own error.
export function KeyValueRows({
  idPrefix,
  rows,
  onChange,
  labels,
  errors = {},
  disabled,
  addDisabled,
}: {
  idPrefix: string;
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  labels: KvLabels;
  errors?: Record<number, string>;
  disabled?: boolean;
  addDisabled?: boolean;
}) {
  const set = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2">
            <Input
              id={`${idPrefix}-key-${i}`}
              aria-label={labels.key}
              placeholder={labels.keyPlaceholder}
              value={r.key}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[13px]"
              aria-invalid={errors[i] ? true : undefined}
              onChange={(e) => set(i, { key: e.target.value })}
            />
            <Input
              id={`${idPrefix}-value-${i}`}
              aria-label={labels.value}
              placeholder={labels.valuePlaceholder}
              value={r.value}
              readOnly={r.locked !== undefined}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[13px]"
              aria-invalid={errors[i] ? true : undefined}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <Button type="button" size="sm" variant="ghost" aria-label={labels.remove(r.key.trim() || String(i + 1))} disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ×
            </Button>
          </div>
          {errors[i] ? (
            <p id={`${idPrefix}-error-${i}`} role="alert" className="text-[13px] text-danger-text">
              {errors[i]}
            </p>
          ) : null}
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" className="self-start" disabled={disabled || addDisabled} onClick={() => onChange([...rows, { key: "", value: "" }])}>
        {labels.add}
      </Button>
    </div>
  );
}
