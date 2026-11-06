import { ChevronDown, ChevronUp } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";

// Bounded keeps any list or table to a set height. Past it the content scrolls, and a toggle opens it
// up to most of the screen and closes it again; the toggle only appears when something is cut off.
export function BoundedList(props: React.HTMLAttributes<HTMLUListElement>) {
  return (
    <Bounded>
      <ul {...props} />
    </Bounded>
  );
}

const CLOSED_MAX_PX = 384; // max-h-96

/** The height that ends on a row's edge, so the closed list never shows half a row. Null with no rows past the cap. */
export function wholeRowsHeight(el: HTMLElement): number | null {
  const top = el.getBoundingClientRect().top - el.scrollTop;
  let fit: number | null = null;
  let past = false;
  for (const row of el.querySelectorAll("tbody > tr, ul > li")) {
    const bottom = row.getBoundingClientRect().bottom - top;
    if (bottom <= CLOSED_MAX_PX) fit = bottom;
    else past = true;
  }
  return past ? fit : null;
}

export function Bounded({ children, className }: { children: ReactNode; className?: string }) {
  const { t } = useTranslation("common");
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [cut, setCut] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
      setCut(wholeRowsHeight(el));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        ref={ref}
        data-testid="bounded"
        tabIndex={overflows ? 0 : undefined}
        style={!open && cut !== null ? { maxHeight: cut } : undefined}
        className={cn("min-w-0 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-focus", open ? "max-h-[70vh]" : "max-h-96", className)}
      >
        {children}
      </div>
      {overflows || open ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full cursor-pointer items-center justify-center gap-1 border-t border-line py-2 text-[13px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
          {open ? <ChevronUp className="size-3.5" aria-hidden="true" /> : <ChevronDown className="size-3.5" aria-hidden="true" />}
          {open ? t("showLess") : t("showMore")}
        </button>
      ) : null}
    </>
  );
}

export interface BoundedItemsProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Items shown before the list is cut: 10 in a card, 5 on an overview. */
  maxItems?: number;
  title?: ReactNode;
  /** `<pageId>.<cardId>`: makes the card collapsible, remembered in localStorage as ui.collapse.<id>. */
  collapseId?: string;
  /** A link to the full page. It replaces expanding in place. */
  viewAll?: ReactNode;
  empty?: ReactNode;
  className?: string;
}

const collapseKey = (id: string) => `ui.collapse.${id}`;

function readCollapsed(id: string | undefined): boolean {
  if (!id) return false;
  try {
    return localStorage.getItem(collapseKey(id)) === "1";
  } catch {
    return false;
  }
}

// BoundedItems counts items, where Bounded caps a height: it shows at most maxItems, then either opens the rest in an
// inner scroll of at most 480 px or links to the full page (guidelines rule 5).
export function BoundedItems<T>({ items, getKey, renderItem, maxItems = 10, title, collapseId, viewAll, empty, className }: BoundedItemsProps<T>) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(collapseId));

  function onOpenChange(open: boolean) {
    setCollapsed(!open);
    if (!collapseId) return;
    try {
      localStorage.setItem(collapseKey(collapseId), open ? "0" : "1");
    } catch {
      // Private mode or blocked storage: the choice lasts for this view only.
    }
  }

  const cut = items.length > maxItems;
  const visible = expanded ? items : items.slice(0, maxItems);
  const body =
    items.length === 0 && empty != null ? (
      empty
    ) : (
      <>
        <ul className={cn("flex min-w-0 flex-col", expanded && "max-h-[480px] overflow-y-auto overscroll-contain")}>
          {visible.map((item) => (
            <li key={getKey(item)} className="min-w-0">
              {renderItem(item)}
            </li>
          ))}
        </ul>
        {viewAll ? (
          <div className="pt-2 text-[13px]">{viewAll}</div>
        ) : cut ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="min-h-8 cursor-pointer rounded-sm pt-2 text-start text-[13px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
          >
            {expanded ? t("showLess") : t("showAllCount", { total: items.length })}
          </button>
        ) : null}
      </>
    );

  if (!collapseId) {
    return (
      <div className={cn("flex min-w-0 flex-col", className)}>
        {title != null ? <div className="pb-2 text-sm font-medium text-text">{title}</div> : null}
        {body}
      </div>
    );
  }
  return (
    <Collapsible open={!collapsed} onOpenChange={onOpenChange} className={cn("flex min-w-0 flex-col", className)}>
      <CollapsibleTrigger className="flex min-h-8 cursor-pointer items-center justify-between gap-2 rounded-sm pb-2 text-sm font-medium text-text outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {title}
        <ChevronDown aria-hidden="true" className={cn("size-4 text-muted transition-transform", collapsed && "-rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col">{body}</CollapsibleContent>
    </Collapsible>
  );
}
