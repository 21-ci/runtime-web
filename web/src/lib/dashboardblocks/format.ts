const LOCALE = 'en-US'
const MINUS = '−'

const cache = new Map<string, Intl.NumberFormat>()

function numberFormat(options: Intl.NumberFormatOptions) {
  const key = JSON.stringify(options)
  let format = cache.get(key)
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options)
    cache.set(key, format)
  }
  return format
}

interface FormatOptions {
  /** @default 1 */
  maximumFractionDigits?: number
  /** @default 0 */
  minimumFractionDigits?: number
}

function formatNumber(value: number, options: FormatOptions = {}) {
  return numberFormat({ maximumFractionDigits: 1, ...options }).format(value)
}

/** A whole count, such as a balance of credits, with a real minus below 0: `−1,250`. */
function formatCount(value: number) {
  const rounded = Math.round(value)
  const text = numberFormat({ maximumFractionDigits: 0 }).format(Math.abs(rounded))
  return rounded < 0 ? `${MINUS}${text}` : text
}

function formatCompact(value: number) {
  return numberFormat({ maximumFractionDigits: 1, notation: 'compact' }).format(value)
}

/**
 * How many decimals a money metric shows. It's chosen for the metric, never for the value, so a column never mixes `$49.00` with `$2,240`.
 * - `whole`: `$48,290`, for totals, MRR and KPIs.
 * - `exact`: the currency's minor units, `$49.00` (`¥4,900`), for an amount someone pays, is owed or is charged: invoices, payments, prices, line items.
 * - `fine`: `exact`, with amounts under one unit to two significant digits (`$0.42`, `$0.0042`), for per-request costs.
 */
type CurrencyPrecision = 'whole' | 'exact' | 'fine'

interface CurrencyOptions {
  /** `$48K` instead of `$48,290`. */
  compact?: boolean
  /** @default 'USD' */
  currency?: string
  /** @default 'whole' */
  precision?: CurrencyPrecision
}

function getCurrencyDigits(currency = 'USD') {
  return (
    numberFormat({ currency, style: 'currency' }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/** A money value in the currency's smallest unit, rounded half away from zero: $1.005 is 101 cents. */
function toMinorUnits(value: number, currency = 'USD') {
  const scale = 10 ** getCurrencyDigits(currency)
  // The epsilon keeps 1.005 from rounding down because it's stored as 1.00499…
  return Math.sign(value) * Math.round(Math.abs(value) * scale + 1e-6)
}

/** The symbol written before an amount: `$` for USD, `€` for EUR, `£` for GBP. */
function getCurrencySymbol(currency = 'USD') {
  return (
    numberFormat({ currency, currencyDisplay: 'narrowSymbol', style: 'currency' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value ?? currency
  )
}

function currencyDigits(value: number, currency: string, precision: CurrencyPrecision) {
  if (precision === 'whole') return 0
  const digits = getCurrencyDigits(currency)
  const rounded = Math.abs(Number(value.toPrecision(2)))
  if (precision === 'exact' || rounded === 0 || rounded >= 1) return digits
  return Math.max(digits, 1 - Math.floor(Math.log10(rounded)))
}

function formatCurrency(value: number, options: CurrencyOptions = {}) {
  const { compact = false, currency = 'USD', precision = 'whole' } = options
  if (compact) {
    return numberFormat({
      currency,
      maximumFractionDigits: 1,
      minimumFractionDigits: 0,
      notation: 'compact',
      style: 'currency',
    }).format(value)
  }
  const digits = currencyDigits(value, currency, precision)
  return numberFormat({
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
    style: 'currency',
  }).format(value)
}

const ordinalRules = new Intl.PluralRules(LOCALE, { type: 'ordinal' })
const ordinalSuffixes: Record<Intl.LDMLPluralRule, string> = {
  few: 'rd',
  many: 'th',
  one: 'st',
  other: 'th',
  two: 'nd',
  zero: 'th',
}

/** `1st`, `2nd`, `23rd`. */
function formatOrdinal(value: number) {
  return `${formatNumber(value, { maximumFractionDigits: 0 })}${ordinalSuffixes[ordinalRules.select(value)]}`
}

const listFormat = new Intl.ListFormat(LOCALE, { style: 'long', type: 'conjunction' })
const orListFormat = new Intl.ListFormat(LOCALE, { style: 'long', type: 'disjunction' })

/** `Ada`, `Ada and Lin`, `Ada, Lin, and Sam`. */
/** Joins with "and", or with "or" for choices: `formatList(['Germany', 'France'], 'or')`. */
function formatList(items: string[], joiner: 'and' | 'or' = 'and') {
  return (joiner === 'or' ? orListFormat : listFormat).format(items)
}

/** Takes a ratio: `0.125` is `12.5%`. */
function formatPercent(ratio: number, options: FormatOptions = {}) {
  return numberFormat({ maximumFractionDigits: 1, style: 'percent', ...options }).format(
    ratio,
  )
}

/** A difference with its sign, written with a real minus: `+12`, `−3.5`, `0`. */
function formatSigned(value: number, format: (value: number) => string = formatNumber) {
  if (value === 0) return format(0)
  return `${value > 0 ? '+' : MINUS}${format(Math.abs(value))}`
}

/** Percentage points: `1.2 pts`, `1 pt`. */
function formatPoints(value: number, options: FormatOptions = {}) {
  const text = formatNumber(value, options)
  return `${text} ${Math.abs(value) === 1 ? 'pt' : 'pts'}`
}

const dateCache = new Map<string, Intl.DateTimeFormat>()

function dateFormat(options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options)
  let format = dateCache.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, options)
    dateCache.set(key, format)
  }
  return format
}

/** An instant (a `Date`, a timestamp in milliseconds or an ISO string), or a `YYYY-MM-DD` calendar day. */
type DateInput = Date | number | string

const isCalendarDay = (date: DateInput): date is string =>
  typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)

/** A `YYYY-MM-DD` string is that calendar day, at midnight UTC; any other date string is an instant. */
function toDate(date: DateInput) {
  if (date instanceof Date) return date
  if (typeof date === 'number') return new Date(date)
  return new Date(isCalendarDay(date) ? `${date}T00:00:00Z` : date)
}

interface ZonedParts {
  day: number
  hour: number
  minute: number
  /** 1 to 12. */
  month: number
  second: number
  year: number
}

/** The wall-clock reading of an instant in `timeZone`, for date math. A `YYYY-MM-DD` string is that day in every zone. */
function zonedParts(date: DateInput, timeZone: string): ZonedParts {
  const parts = dateFormat({
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
    minute: 'numeric',
    month: 'numeric',
    second: 'numeric',
    timeZone: isCalendarDay(date) ? 'UTC' : timeZone,
    year: 'numeric',
  }).formatToParts(toDate(date))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value)
  return {
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
    month: part('month'),
    second: part('second'),
    year: part('year'),
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** The `YYYY-MM-DD` day an instant falls on in `timeZone`. */
function dayIn(date: DateInput, timeZone: string) {
  const { day, month, year } = zonedParts(date, timeZone)
  return `${year}-${pad(month)}-${pad(day)}`
}

/** The canonical IANA name for `timeZone` (`America/New_York`), or `null` when this runtime doesn't know it. Without one, the runtime's own zone. */
function resolveTimeZone(timeZone?: string) {
  try {
    return dateFormat(timeZone === undefined ? {} : { timeZone }).resolvedOptions()
      .timeZone
  } catch {
    return null
  }
}

type HourCycle = 'h12' | 'h23'

/**
 * The clock `locale` reads: `h23` for 15:42, `h12` for 3:42 PM. Without one, the runtime's own
 * locale, which differs between a server and a browser: read it after hydration.
 */
function resolveHourCycle(locale?: string): HourCycle {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions()
    .hourCycle
  return cycle === 'h11' || cycle === 'h12' ? 'h12' : 'h23'
}

/** Whether `timeZone` is an IANA name this runtime knows, such as `Europe/London`. */
function isTimeZone(timeZone: string) {
  return resolveTimeZone(timeZone) !== null
}

/** The zone's offset from GMT at `date`: `GMT-5`, `GMT+5:30`, `GMT`. */
function formatTimeZoneOffset(date: DateInput, timeZone: string) {
  const offset = dateFormat({ timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(toDate(date))
    .find((part) => part.type === 'timeZoneName')?.value
  // ICU 78 (Node 26, Chrome 153) writes a zero offset as `GMT+0`, earlier versions as `GMT`.
  return !offset || offset === 'GMT+0' ? 'GMT' : offset
}

/** `Dec 14` in `now`'s year, `Dec 14, 2026` in another or without `now`. An instant is read in `timeZone`; a `YYYY-MM-DD` string is that day. */
function formatDay(date: DateInput, now?: DateInput, timeZone = 'UTC') {
  const zone = isCalendarDay(date) ? 'UTC' : timeZone
  const year = (value: DateInput) => dayIn(toDate(value), zone).slice(0, 4)
  const sameYear = now !== undefined && year(date) === year(now)
  return formatDate(date, sameYear ? 'day' : 'date', zone)
}

const DATE_STYLES = {
  /** `15:42:07`, a 24-hour clock with seconds, for logs, traces and audit trails. */
  clock: { hour: '2-digit', hourCycle: 'h23', minute: '2-digit', second: '2-digit' },
  /** `15:42:07 UTC` */
  'clock-zone': {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  },
  /** `Dec 14, 2026` */
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  /** `Dec 14, 2026, 15:42:07 UTC`, an event in a log someone may compare with another system's. */
  'date-clock-zone': {
    day: 'numeric',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: 'short',
    second: '2-digit',
    timeZoneName: 'short',
    year: 'numeric',
  },
  /** `Dec 14, 2026, 3:42 PM` */
  'date-time': {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  },
  /** `Dec 14` */
  day: { day: 'numeric', month: 'short' },
  /** `Dec 14, 15:42`, a log line from another day. */
  'day-clock': {
    day: 'numeric',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: 'short',
  },
  /** `Dec 14, 3:42 PM` */
  'day-time': { day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short' },
  /** `Oct` */
  month: { month: 'short' },
  /** `October` */
  'month-long': { month: 'long' },
  /** `October 2026` */
  'month-long-year': { month: 'long', year: 'numeric' },
  /** `Oct 2026` */
  'month-year': { month: 'short', year: 'numeric' },
  /** `3:42 PM` */
  time: { hour: 'numeric', minute: '2-digit' },
  /** `15:42`, for someone who reads a 24-hour clock. */
  'time-24': { hour: '2-digit', hourCycle: 'h23', minute: '2-digit' },
  /** `15:42 UTC`, an incident or a log line read across zones. */
  'time-24-zone': {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZoneName: 'short',
  },
  /** `3:42 PM UTC` */
  'time-zone': { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
  /** `Mon` */
  weekday: { weekday: 'short' },
  /** `Mon, Dec 14` */
  'weekday-day': { day: 'numeric', month: 'short', weekday: 'short' },
  /** `Mon, 3:42 PM`, a time later this week. */
  'weekday-time': { hour: 'numeric', minute: '2-digit', weekday: 'short' },
  /** `Mon, Dec 14, 2026` */
  'weekday-date': { day: 'numeric', month: 'short', weekday: 'short', year: 'numeric' },
  /** `Mon, Dec 14, 3:42 PM` */
  'weekday-day-time': {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    weekday: 'short',
  },
  /** `Mon, Dec 14, 3:42 PM UTC`, a handover or a deadline people in other zones read. */
  'weekday-day-time-zone': {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZoneName: 'short',
    weekday: 'short',
  },
  /** `Dec 14, 15:42 UTC` */
  'day-clock-zone': {
    day: 'numeric',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: 'short',
    timeZoneName: 'short',
  },
  /** `Monday` */
  'weekday-long': { weekday: 'long' },
  /** `Monday, Dec 14` */
  'weekday-long-day': { day: 'numeric', month: 'short', weekday: 'long' },
  /** `M` */
  'weekday-narrow': { weekday: 'narrow' },
  /** `2026` */
  year: { year: 'numeric' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

type DateStyle = keyof typeof DATE_STYLES

/** Writes a date in one of the library's styles, read in `timeZone`. A `YYYY-MM-DD` string is that day in any zone. */
function formatDate(date: DateInput, style: DateStyle, timeZone = 'UTC') {
  return (
    dateFormat({
      ...DATE_STYLES[style],
      timeZone: isCalendarDay(date) ? 'UTC' : timeZone,
    })
      .format(toDate(date))
      // Some ICU versions put a narrow no-break space before AM and PM; the server's and the browser's text must match.
      .replace(/\u202f/g, ' ')
  )
}

interface DateRangeOptions {
  /** `' to '` in a sentence. @default ' – ' */
  joiner?: string
  /** @default 'UTC' */
  timeZone?: string
  /** Ends a range within one year with it too: `Mar 3 – 9, 2026`. */
  year?: boolean
}

/** `Mar 3 – 9`, `Mar 28 – Apr 3`, `Dec 28, 2025 – Jan 3, 2026`. */
function formatDateRange(
  { end, start }: { end: Date; start: Date },
  { joiner = ' – ', timeZone = 'UTC', year = false }: DateRangeOptions = {},
) {
  const from = zonedParts(start, timeZone)
  const to = zonedParts(end, timeZone)
  if (from.year !== to.year) {
    return `${formatDate(start, 'date', timeZone)}${joiner}${formatDate(end, 'date', timeZone)}`
  }
  const first = formatDate(start, 'day', timeZone)
  const range =
    from.month !== to.month
      ? `${first}${joiner}${formatDate(end, 'day', timeZone)}`
      : from.day !== to.day
        ? `${first}${joiner}${to.day}`
        : first
  return year ? `${range}, ${to.year}` : range
}

/** Two times of day joined by an en dash, such as `16:00 – 17:00`, each in `style`. */
function formatTimeRange(
  { end, start }: { end: DateInput; start: DateInput },
  style: 'time' | 'time-24',
  timeZone = 'UTC',
) {
  return `${formatDate(start, style, timeZone)} – ${formatDate(end, style, timeZone)}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const relativeCache = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormat(style: Intl.RelativeTimeFormatStyle) {
  let format = relativeCache.get(style)
  if (!format) {
    format = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto', style })
    relativeCache.set(style, format)
  }
  return format
}

/** Calendar days from `now` to `date` in `timeZone`: `-1` is yesterday. A `YYYY-MM-DD` string is that day wherever the reader is. */
function daysBetween(now: DateInput, date: DateInput, timeZone: string) {
  return Math.round(
    (Date.parse(dayIn(date, timeZone)) - Date.parse(dayIn(now, timeZone))) / DAY,
  )
}

/** A count of calendar days from today: `today`, `tomorrow`, `in 12 days`, `3 days ago`. */
function formatRelativeDays(days: number, style: Intl.RelativeTimeFormatStyle = 'long') {
  return relativeFormat(style).format(days, 'day')
}

/** A heading for a day of a list or an agenda: `Today`, `Yesterday`, `Tomorrow`, then `Monday, Dec 14`. */
function formatDayHeading(date: DateInput, now: Date, timeZone = 'UTC') {
  const days = daysBetween(now, toDate(date), isCalendarDay(date) ? 'UTC' : timeZone)
  if (days === 0) return 'Today'
  if (days === -1) return 'Yesterday'
  if (days === 1) return 'Tomorrow'
  return formatDate(date, 'weekday-long-day', timeZone)
}

interface RelativeTimeOptions {
  /** @default 'short' */
  style?: Intl.RelativeTimeFormatStyle
  /** @default 'UTC' */
  timeZone?: string
}

/**
 * How long ago or how soon, past or future: `just now`, `5 min. ago`, `in 3 hr.`, `3:42 PM` earlier today, `yesterday`, `in 3 days`, then the day (`Oct 6`).
 * Pass a fixed `now`, so the server and the browser write the same text.
 */
function formatRelativeTime(
  date: DateInput,
  now: Date,
  { style = 'short', timeZone = 'UTC' }: RelativeTimeOptions = {},
) {
  const instant = toDate(date)
  const difference = instant.getTime() - now.getTime()
  const sign = difference < 0 ? -1 : 1
  const elapsed = Math.abs(difference)
  const format = relativeFormat(style)
  if (elapsed < MINUTE) return difference <= 0 ? 'just now' : format.format(1, 'minute')
  if (elapsed < HOUR) return format.format(sign * Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < 12 * HOUR) return format.format(sign * Math.floor(elapsed / HOUR), 'hour')
  const days = daysBetween(now, instant, timeZone)
  if (days === 0) return formatDate(instant, 'time', timeZone)
  if (Math.abs(days) < 7) return format.format(days, 'day')
  return formatDay(instant, now, timeZone)
}

interface DurationOptions {
  /** `minute` drops the seconds, for time tracked on work: `2 h 59 min`, `0 min`. @default 'millisecond' */
  smallest?: 'millisecond' | 'minute'
  /** `rough` gives one unit up to days, with one decimal under 10, for a typical wait such as a median: `6 min`, `4.5 h`, `1.8 days`. @default 'exact' */
  style?: 'exact' | 'rough'
}

function roughDuration(ms: number) {
  const units: [number, string, string][] = [
    [86_400_000, 'day', 'days'],
    [3_600_000, 'h', 'h'],
    [60_000, 'min', 'min'],
    [1000, 's', 's'],
  ]
  const [size, one, many] = units.find(([size]) => ms >= size) ?? units[units.length - 1]
  const amount = ms / size
  const value = amount < 10 ? Math.floor(amount * 10) / 10 : Math.floor(amount)
  return `${value}\u00a0${value === 1 ? one : many}`
}

/** A length of time from milliseconds, for thinking, tool calls and runs: `640 ms`, `4.2 s`, `2 min 5 s`, `1 h 20 min`; or roughly, `1.8 days`. */
function formatDuration(
  ms: number,
  { smallest = 'millisecond', style = 'exact' }: DurationOptions = {},
) {
  if (style === 'rough') return roughDuration(ms)
  const unit = (value: number, name: string) => `${value}\u00a0${name}`
  if (smallest === 'minute' && ms < 60_000) return unit(0, 'min')
  if (ms < 1000) return unit(Math.floor(ms), 'ms')
  if (ms < 10_000) return unit(Math.floor(ms / 100) / 10, 's')
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return unit(seconds, 's')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = smallest === 'minute' ? 0 : seconds % 60
    return rest ? `${unit(minutes, 'min')} ${unit(rest, 's')}` : unit(minutes, 'min')
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${unit(hours, 'h')} ${unit(rest, 'min')}` : unit(hours, 'h')
}

/** A running timer from milliseconds, hours first: `0:04:09`, `2:59:58`, `12:00:00`. */
function formatTimer(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  return `${hours}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

/** Joins the parts that are set with ` · `. */
function joinDetails(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' · ')
}

export {
  formatCount,
  dayIn,
  daysBetween,
  formatCompact,
  formatCurrency,
  formatDate,
  formatDateRange,
  formatDay,
  formatDayHeading,
  formatDuration,
  formatList,
  formatNumber,
  formatOrdinal,
  formatPercent,
  formatPoints,
  formatRelativeDays,
  formatRelativeTime,
  formatSigned,
  formatTimeRange,
  formatTimer,
  formatTimeZoneOffset,
  getCurrencyDigits,
  getCurrencySymbol,
  isTimeZone,
  joinDetails,
  resolveHourCycle,
  resolveTimeZone,
  toMinorUnits,
  zonedParts,
}

export type {
  CurrencyOptions,
  DateRangeOptions,
  CurrencyPrecision,
  DateInput,
  DateStyle,
  DurationOptions,
  FormatOptions,
  HourCycle,
  RelativeTimeOptions,
  ZonedParts,
}
