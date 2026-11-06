import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { download, toCsv, toJson } from "@/lib/export";

type Size = "sm" | "default";

export type ExportMenuProps<F extends string = string> =
  /** Rows the page already holds and which are the whole set (a chart's series). */
  | { name: string; rows: readonly Record<string, unknown>[]; size?: Size }
  /** A server export: href builds the route with `format=` and the filters on screen. */
  | { formats: readonly F[]; href: (format: F) => string; label?: string; disabled?: boolean; size?: Size };

// ExportMenu is the one way out of a page (guidelines rule 10). The browser fetches a server export itself, so the
// file streams to disk under the session cookie and the server sets its name.
export function ExportMenu<F extends string = string>(props: ExportMenuProps<F>) {
  const { t } = useTranslation("common");
  const size = props.size ?? "sm";

  if ("rows" in props) {
    const { name, rows } = props;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size={size} disabled={rows.length === 0}>
            <Download aria-hidden="true" /> {t("export")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => download(`${name}.csv`, toCsv(rows), "text/csv;charset=utf-8")}>CSV</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download(`${name}.json`, toJson(rows), "application/json")}>JSON</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const { formats, href, label = t("export"), disabled = false } = props;
  const only = formats.length === 1 ? formats[0] : undefined;
  if (disabled) {
    return (
      <Button variant="secondary" size={size} disabled>
        <Download aria-hidden="true" /> {label}
      </Button>
    );
  }
  if (only !== undefined) {
    return (
      <Button asChild variant="secondary" size={size}>
        <a href={href(only)} download>
          <Download aria-hidden="true" /> {label}
        </a>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size={size}>
          <Download aria-hidden="true" /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {formats.map((f) => (
          <DropdownMenuItem key={f} asChild>
            <a href={href(f)} download>{`.${f}`}</a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
