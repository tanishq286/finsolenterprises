/**
 * Formatting helpers. Everything renders in Indian conventions and IST so the
 * server and browser always agree (no hydration drift from local time zones).
 */

const IST = "Asia/Kolkata";

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const inrExact = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const count = new Intl.NumberFormat("en-IN");

/** 8496000 paise → "₹84,960" */
export function formatPaise(paise: number, opts: { exact?: boolean } = {}): string {
  const rupees = paise / 100;
  return opts.exact ? inrExact.format(rupees) : inr.format(rupees);
}

export function formatCount(n: number): string {
  return count.format(n);
}

/** Basis points → "10%" */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
}

/** Integer paise share of a value, rounded down (fees never round up against the client). */
export function shareOfPaise(paise: number, bps: number): number {
  return Math.floor((paise * bps) / 10_000);
}

function toDate(value: string): Date {
  // Calendar dates (YYYY-MM-DD) are anchored to midday IST so they never slip a day.
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+05:30`) : new Date(value);
}

/** "2 Oct 2026" */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: IST,
  }).format(toDate(value));
}

/** "Fri, 2 Oct" */
export function formatDayShort(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: IST,
  }).format(toDate(value));
}

/** "27 Sep 2026, 10:04 IST" */
export function formatDateTime(value: string): string {
  const d = toDate(value);
  const date = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: IST,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: IST,
  }).format(d);
  return `${date}, ${time} IST`;
}

/** "27 Sep 2026, 10:04:12 IST" — for receipts. */
export function formatReceiptTime(value: string): string {
  const d = toDate(value);
  const date = new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: IST,
  }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: IST,
  }).format(d);
  return `${date}, ${time} IST`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "3f9ac2…a1c21e" — full value stays available for copy and screen readers. */
export function shortHash(hex: string): string {
  return `${hex.slice(0, 8)}…${hex.slice(-6)}`;
}

/** Newest-first comparator for ISO instants with any offset ("Z" or "+05:30"). */
export function byNewest(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a);
}

/** Milliseconds since the epoch for an ISO instant or calendar date (IST midday). */
export function instant(value: string): number {
  return toDate(value).getTime();
}

/** Whole calendar days between two instants, counted in IST. */
export function daysBetween(from: string, to: string): number {
  const day = (v: string) => {
    const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: IST })
      .format(toDate(v))
      .split("-")
      .map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return Math.max(0, Math.round(day(to) - day(from)));
}

/** 0 → "same day", 1 → "1 day", 22 → "22 days" */
export function formatDays(days: number): string {
  if (days === 0) return "same day";
  return `${formatCount(days)} day${days === 1 ? "" : "s"}`;
}

/** "18 Aug" — short date for axis labels; the year is carried by the caption. */
export function formatDayMonth(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: IST }).format(
    toDate(value),
  );
}

/** 49_43_040_00 paise → "₹49.4 lakh"; crore above 1 crore. Indian units, for estimates. */
export function formatPaiseCompact(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 1_00_00_000)
    return `₹${(rupees / 1_00_00_000).toFixed(rupees >= 10_00_00_000 ? 0 : 1)} crore`;
  if (rupees >= 1_00_000)
    return `₹${(rupees / 1_00_000).toFixed(rupees >= 10_00_000 ? 0 : 1)} lakh`;
  return inr.format(Math.round(rupees));
}

/** Words that stay lower case inside a title-cased company name, and fixed spellings. */
const NAME_JOINERS = new Set(["and", "of", "the", "for", "&"]);
const NAME_FIXED: Record<string, string> = { LTD: "Ltd", PVT: "Pvt", CO: "Co" };

/**
 * "TATA CONSUMER PRODUCTS LIMITED" → "Tata Consumer Products Limited". Only
 * names written entirely in capitals change; acronyms stay in capitals when
 * they are short (ITC, BSE) or have no vowels (HDFC, BPCL, NMDC).
 */
export function companyDisplayName(name: string): string {
  if (name !== name.toUpperCase() || !/[A-Z]/.test(name)) return name;
  return name
    .split(/(\s+|-|\(|\))/)
    .map((w, i) => {
      const letters = w.replace(/[^A-Z]/g, "");
      if (!letters || !/^[A-Z.&']+$/.test(w)) return w;
      if (NAME_FIXED[letters]) return w.replace(letters, NAME_FIXED[letters]!);
      const lower = w.toLowerCase();
      if (i > 0 && NAME_JOINERS.has(lower)) return lower;
      if (letters.length <= 3 || !/[AEIOU]/.test(letters)) return w;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/**
 * The years of statements on record, never past the current year or the year
 * the latest statement was published (a "due for transfer" year can be in the
 * future, and is not a statement period).
 */
export function statementYears(
  oldest: number | null,
  newest: number | null,
  latestPublishedAt: string | null,
  now: Date = new Date(),
): string {
  if (oldest === null) return "Not known";
  const published = latestPublishedAt ? new Date(latestPublishedAt).getUTCFullYear() : NaN;
  const cap = Math.min(now.getUTCFullYear(), Number.isFinite(published) ? published : Infinity);
  const last = Math.min(newest ?? oldest, cap);
  const first = Math.min(oldest, last);
  return first === last ? String(first) : `${first}–${last}`;
}

/** A lower bound for headline figures: 73,81,440 rupees → "₹73+ Lakhs"; 3.03 crore → "₹3+ Crore". */
export function formatPaisePlus(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 1_00_00_000) return `₹${Math.floor(rupees / 1_00_00_000)}+ Crore`;
  if (rupees >= 1_00_000) return `₹${Math.floor(rupees / 1_00_000)}+ Lakhs`;
  return `₹${formatCount(Math.floor(rupees / 1000))}+ thousand`;
}
