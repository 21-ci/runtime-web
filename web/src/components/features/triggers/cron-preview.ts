// describeCron turns a 5-field cron expression (minute hour day-of-month month day-of-week) into
// plain English. It covers the common shapes: fixed times, steps, weekday ranges and fixed dates.
// It returns null for anything it does not recognise, so the UI can say so instead of guessing.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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
  if (SINGLE.test(min) && SINGLE.test(hour)) return `At ${pad(hour)}:${pad(min)}`;
  if (SINGLE.test(min) && hour === "*") return `At minute ${min} of every hour`;
  if (min === "*" && hour === "*") return "Every minute";
  const minStep = STEP.exec(min);
  if (minStep && hour === "*") return `Every ${minStep[1]} minutes`;
  const hourStep = STEP.exec(hour);
  if (SINGLE.test(min) && hourStep) return `At minute ${min}, every ${hourStep[1]} hours`;
  return null;
}

function dayName(n: string): string {
  return DAYS[Number(n) % 7];
}

// weekdayPart renders a day-of-week field such as "1-5" or "0,6". Steps and wildcards are not
// named here, so they return null.
function weekdayPart(dow: string): string | null {
  const names: string[] = [];
  for (const part of dow.split(",")) {
    const span = SPAN.exec(part);
    if (span) {
      names.push(`${dayName(span[1])} through ${dayName(span[2])}`);
    } else if (SINGLE.test(part)) {
      names.push(dayName(part));
    } else {
      return null;
    }
  }
  return names.join(", ");
}

function dayPart(dom: string, mon: string, dow: string): string | null {
  if (dom === "*" && mon === "*" && dow === "*") return "every day";
  if (dom === "*" && mon === "*") return weekdayPart(dow);
  if (dow === "*" && mon === "*" && SINGLE.test(dom)) return `on day ${dom} of every month`;
  if (dow === "*" && SINGLE.test(dom) && SINGLE.test(mon)) return `on ${MONTHS[Number(mon)]} ${dom}`;
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
  return `${time}, ${day}`;
}
