/**
 * Normalisation and validation of imported holder identity fields.
 *
 * Rules:
 * - Raw values are never changed here; callers store them separately.
 * - Placeholder tokens a statement uses for "not available" (NA, N.A., NIL,
 *   dashes) are removed from the normalised value and reported.
 * - Values that look like a neighbouring cell leaked in (digits, a trailing
 *   care-of marker, a dangling dash or comma) are not cleaned up by guessing:
 *   the row is quarantined for a person to review.
 * - Nothing is inferred: a missing relative stays missing.
 */

export type ValidationStatus = "VALID" | "WARNING" | "QUARANTINED";

/** Issue codes, and whether each one only warns or needs review before publishing. */
export const ISSUE_SEVERITY = {
  /** A placeholder such as "NA" was removed from the father/spouse name. */
  RELATIVE_PLACEHOLDER_REMOVED: "WARNING",
  /** No father/spouse name in the source. */
  RELATIVE_MISSING: "WARNING",
  /** The father/spouse text holds digits, a care-of marker or a dangling dash: likely address spill-over. */
  RELATIVE_SUSPECT: "QUARANTINED",
  /** The holder's name wrapped across lines in the source cell; the joined name needs checking. */
  WRAPPED_NAME: "QUARANTINED",
  /** Text from a separate line group was joined to this row. */
  MERGED_FRAGMENT: "WARNING",
  /**
   * The name continued on the next line of a folio-led table (each holder's
   * first line carries its folio and amount, so the line can only be theirs).
   */
  NAME_CONTINUED: "WARNING",
  /** The PIN code sat in the folio cell (columns shifted in the source); it was moved to the PIN. */
  PIN_IN_FOLIO: "WARNING",
  /** A demat account number shorter than 16 characters: the source cut it off. */
  FOLIO_INCOMPLETE: "QUARANTINED",
  /** The investor name contains digits. */
  NAME_SUSPECT: "QUARANTINED",
  /** No six-digit PIN code. */
  PIN_MISSING: "WARNING",
  /** No address in the source. */
  ADDRESS_MISSING: "WARNING",
  /** The state came from the PIN code, not the statement's state column. */
  STATE_FROM_PIN: "WARNING",
  /** Neither a state nor a PIN code: the record sits under "state not stated". */
  STATE_NOT_STATED: "WARNING",
  /** The date column could not be read. */
  EVENT_DATE_MISSING: "WARNING",
  /** The amount cell held more than one number. */
  AMOUNT_AMBIGUOUS: "QUARANTINED",
  /** The row could not be read as a holder at all (see the message). */
  UNREADABLE: "QUARANTINED",
  /** An existing record that a re-read of its source did not produce again. */
  NOT_REFOUND: "QUARANTINED",
} as const satisfies Record<string, ValidationStatus>;

export type IssueCode = keyof typeof ISSUE_SEVERITY;

export const ISSUE_LABELS: Record<IssueCode, string> = {
  RELATIVE_PLACEHOLDER_REMOVED: "Placeholder removed from father/spouse name",
  RELATIVE_MISSING: "No father/spouse name in source",
  RELATIVE_SUSPECT: "Father/spouse name may contain address text",
  WRAPPED_NAME: "Holder name wrapped across lines in source",
  MERGED_FRAGMENT: "Fragment joined from a separate line",
  NAME_CONTINUED: "Name continued on the next line in source",
  FOLIO_INCOMPLETE: "Demat account number cut off in source",
  PIN_IN_FOLIO: "PIN code was printed in the folio column",
  NAME_SUSPECT: "Holder name contains digits",
  PIN_MISSING: "No PIN code",
  ADDRESS_MISSING: "No address",
  STATE_FROM_PIN: "State taken from PIN code",
  STATE_NOT_STATED: "No state or PIN in source",
  EVENT_DATE_MISSING: "Date unreadable",
  AMOUNT_AMBIGUOUS: "Amount cell held more than one number",
  UNREADABLE: "Row could not be read",
  NOT_REFOUND: "Not found again when the source was re-read",
};

/** The worst status across a set of issues. */
export function statusOf(issues: readonly IssueCode[]): ValidationStatus {
  if (issues.some((i) => ISSUE_SEVERITY[i] === "QUARANTINED")) return "QUARANTINED";
  return issues.length ? "WARNING" : "VALID";
}

/** Words statements print for "not available". Matched against whole tokens only. */
const PLACEHOLDER_TOKEN = /^(?:n\.?\s?a\.?|nil|none|null|not\s?available)$/i;
/** Bare punctuation: a placeholder on its own, but spill-over next to other text. */
const PUNCT_TOKEN = /^[-‐‑–—.,]+$/;
const CARE_OF = /^(?:c|s|d|w)\/o\.?$/i;

export interface NormalizedRelative {
  /** Normalised father/spouse name, or null when the source gives none. */
  value: string | null;
  issues: IssueCode[];
}

/**
 * Father/spouse name from the statement's parts (first, middle, last) or one
 * full-name cell. "NA" + "" + "SHARMA" becomes "SHARMA" with a warning; "NA"
 * + "C/O" stays as written and is quarantined, because "C/O" belongs to the
 * address and only a person can say what the relative's name is.
 */
export function normalizeRelative(
  parts: readonly (string | null | undefined)[],
): NormalizedRelative {
  const raw = parts
    .map((p) => (p ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  if (!raw) return { value: null, issues: ["RELATIVE_MISSING"] };
  const tokens = raw.split(" ");
  const words = tokens.filter((t) => !PLACEHOLDER_TOKEN.test(t));
  const issues: IssueCode[] = [];
  if (words.length < tokens.length) issues.push("RELATIVE_PLACEHOLDER_REMOVED");
  // Punctuation alone is a placeholder; beside a name it is kept, and suspect.
  const kept = words.every((t) => PUNCT_TOKEN.test(t)) ? [] : words;
  if (!kept.length && words.length && !issues.length) issues.push("RELATIVE_PLACEHOLDER_REMOVED");
  const value = kept.join(" ").trim();
  if (!value) return { value: null, issues: [...issues, "RELATIVE_MISSING"] };
  const suspect =
    /\d/.test(value) ||
    kept.some((t) => CARE_OF.test(t) || PUNCT_TOKEN.test(t)) ||
    /[,‐‑–—-]$/.test(value) ||
    /^[,‐‑–—-]/.test(value);
  if (suspect) issues.push("RELATIVE_SUSPECT");
  return { value, issues };
}

/**
 * Reads one money amount. A cell with more than one number is ambiguous and
 * never concatenated: "1234.50 02" is not 1234.5002.
 */
export function parseAmount(v: unknown): { value: number | null; ambiguous: boolean } {
  if (typeof v === "number") return { value: Number.isFinite(v) ? v : null, ambiguous: false };
  const text = String(v ?? "")
    .replace(/rs\.?|inr|₹/gi, "")
    .trim();
  if (!text || /^[-‐–\s]*$/.test(text)) return { value: 0, ambiguous: false };
  const numbers = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (numbers.length === 1 && /^[\d,.\s]+$/.test(text))
    return { value: Number(numbers[0]!.replace(/,/g, "")), ambiguous: false };
  if (numbers.length === 0) return { value: null, ambiguous: false };
  return { value: null, ambiguous: true };
}

/**
 * What a holder record actually lists. IEPF-2 statements list unclaimed
 * dividend amounts; they do not state a share count, which is then unknown
 * (never zero).
 */
export type RecordKind = "SHARES" | "UNCLAIMED_AMOUNT";

export function recordKind(originalShares: number): RecordKind {
  return originalShares > 0 ? "SHARES" : "UNCLAIMED_AMOUNT";
}

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  SHARES: "Shares listed",
  UNCLAIMED_AMOUNT: "Unclaimed dividend amount (no share count stated)",
};
