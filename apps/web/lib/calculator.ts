import type { HoldingValuation } from "@finsol/shared";

/**
 * Corporate actions since purchase, as drawn on the timeline: every bonus,
 * split, merger and demerger (the purchase itself is not counted). The one
 * count the form, each card and the timeline toggle all show.
 */
export function actionCount(v: Pick<HoldingValuation, "timeline">): number {
  return v.timeline.length;
}

/** One holding is one company bought in one year, whatever the share count. */
export function holdingKey(exchange: string, symbol: string, year: number): string {
  return `${exchange}:${symbol}:${year}`;
}

/**
 * Adds a holding, or replaces the card for the same company and purchase
 * year instead of adding a duplicate. Returns a new list, never mutates.
 */
export function upsertHolding<T extends { key: string }>(
  rows: readonly T[],
  row: T,
): { rows: T[]; updated: boolean } {
  const i = rows.findIndex((r) => r.key === row.key);
  if (i < 0) return { rows: [...rows, row], updated: false };
  return { rows: rows.map((r, j) => (j === i ? row : r)), updated: true };
}

/** The year company pages use for their "100 shares bought in …" example, unless records start later. */
export const EXAMPLE_PURCHASE_YEAR = 1995;

/**
 * The example's purchase year: 1995, or the earliest year anything (a bonus,
 * split or dividend) is recorded for the company when that is later, so a
 * company listed after 1995 is never shown as "bought in 1995".
 */
export function exampleYearFor(actions: readonly { exDate: string }[]): {
  year: number;
  fromRecords: boolean;
} {
  const years = actions.map((a) => Number(a.exDate.slice(0, 4))).filter((y) => y > 1900);
  const earliest = years.length ? Math.min(...years) : null;
  return earliest !== null && earliest > EXAMPLE_PURCHASE_YEAR
    ? { year: earliest, fromRecords: true }
    : { year: EXAMPLE_PURCHASE_YEAR, fromRecords: false };
}

/** "Updated just now", then "Updated at 14:05" once a minute has passed. */
export function syncedText(at: number, now: number): string {
  if (now - at < 60_000) return "Updated just now";
  return `Updated at ${new Date(at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
}
