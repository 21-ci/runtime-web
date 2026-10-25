// describeCron turns a 5-field cron expression (minute hour day-of-month month day-of-week) into
// plain text in the current UI language. It covers the common shapes: fixed times, steps, weekday
// ranges and fixed dates. It returns null for anything it does not recognise, so the UI can say so
// instead of guessing.
import { i18n } from "@/lib/i18n";

// Index 0 is Sunday, matching cron's day-of-week numbering (7 is folded onto 0).
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

// Index 0 is January, so a month number maps to MONTH_KEYS[month - 1].
const MONTH_KEYS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

// Inclusive bounds per field. Day of week accepts 7 as Sunday.
const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const SINGLE = /^\d+$/;
const STEP = /^\*\/(\d+)$/;
const SPAN = /^(\d+)-(\d+)$/;

function validPart(part: string, lo: number, hi: number): boolean {
  if (part === "*") return true;
  const step = STEP.exec(part);
  if (step) return Number(step[1]) > 0;
  if (SINGLE.test(part)) return Number(part) >= lo && Number(part) <= hi;
  const span = SPAN.exec(part);
  if (span) {
    const a = Number(span[1]);
    const b = Number(span[2]);
    return a >= lo && b <= hi && a <= b;
  }
  return false;
}

function validField(field: string, [lo, hi]: [number, number]): boolean {
  return field.split(",").every((part) => validPart(part, lo, hi));
}

function pad(n: string): string {
  return n.padStart(2, "0");
}

function timePart(min: string, hour: string): string | null {
  if (SINGLE.test(min) && SINGLE.test(hour)) {
    return i18n.t("triggers:cron.at", { time: `${pad(hour)}:${pad(min)}` });
  }
  if (SINGLE.test(min) && hour === "*") return i18n.t("triggers:cron.minuteOfHour", { minute: min });
  if (min === "*" && hour === "*") return i18n.t("triggers:cron.everyMinute");
  const minStep = STEP.exec(min);
  if (minStep && hour === "*") {
    const count = Number(minStep[1]);
    return count === 1 ? i18n.t("triggers:cron.everyMinute") : i18n.t("triggers:cron.everyMinutes", { count });
  }
  const hourStep = STEP.exec(hour);
  if (SINGLE.test(min) && hourStep) {
    const count = Number(hourStep[1]);
    return count === 1
      ? i18n.t("triggers:cron.minuteEveryHour", { minute: min })
      : i18n.t("triggers:cron.minuteEveryHours", { minute: min, count });
  }
  return null;
}

function dayNameOf(n: string): string {
  return i18n.t(`triggers:cron.dayNames.${DAY_KEYS[Number(n) % 7]}`);
}

function weekdayOf(n: string): string {
  return i18n.t(`triggers:cron.weekdays.${DAY_KEYS[Number(n) % 7]}`);
}

// weekdayPart renders a day-of-week field such as "1-5" or "0,6". Steps and wildcards are not
// named here, so they return null.
function weekdayPart(dow: string): string | null {
  const names: string[] = [];
  for (const part of dow.split(",")) {
    const span = SPAN.exec(part);
    if (span) {
      names.push(i18n.t("triggers:cron.dayRange", { from: dayNameOf(span[1]), to: dayNameOf(span[2]) }));
    } else if (SINGLE.test(part)) {
      names.push(weekdayOf(part));
    } else {
      return null;
    }
  }
  return names.join(", ");
}

function dayPart(dom: string, mon: string, dow: string): string | null {
  if (dom === "*" && mon === "*" && dow === "*") return i18n.t("triggers:cron.everyDay");
  if (dom === "*" && mon === "*") return weekdayPart(dow);
  if (dow === "*" && mon === "*" && SINGLE.test(dom)) return i18n.t("triggers:cron.dayOfMonth", { day: dom });
  if (dow === "*" && SINGLE.test(dom) && SINGLE.test(mon)) {
    const month = i18n.t(`triggers:cron.months.${MONTH_KEYS[Number(mon) - 1]}`);
    return i18n.t("triggers:cron.onDate", { month, day: dom });
  }
  return null;
}

export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || expr.trim() === "") return null;
  if (!parts.every((p, i) => validField(p, RANGES[i]))) return null;
  const [min, hour, dom, mon, dow] = parts;
  const time = timePart(min, hour);
  const day = dayPart(dom, mon, dow);
  if (!time || !day) return null;
  return i18n.t("triggers:cron.full", { time, day });
}
