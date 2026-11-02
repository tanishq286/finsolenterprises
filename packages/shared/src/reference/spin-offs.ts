/**
 * Demergers ("spin-offs"): on the record date, holders of the parent
 * received shares of a newly listed company. Those shares are part of what a
 * family is owed, so the calculator values them separately from the parent.
 *
 * Every entry was checked against more than one independent source. When the
 * ratio could not be confirmed, ratioFrom/ratioTo are null: the event is shown
 * on the timeline but never valued (an analyst checks it).
 */
export interface SpinOff {
  /** NSE symbol of the parent, as the calculator looks it up. */
  parent: string;
  /** Record date (YYYY-MM-DD): shares held at the close of the previous day count. */
  recordDate: string;
  /** NSE symbol of the company whose shares were received; null when not valued. */
  childSymbol: string | null;
  childName: string;
  /** ratioTo new shares for every ratioFrom parent shares; null when unconfirmed. */
  ratioFrom: number | null;
  ratioTo: number | null;
  source: string;
  note?: string;
}

export const SPIN_OFFS: SpinOff[] = [
  {
    parent: "RELIANCE",
    recordDate: "2006-01-25",
    childSymbol: null,
    childName:
      "Four Reliance ADA Group companies (communications, energy, capital, natural resources)",
    ratioFrom: null,
    ratioTo: null,
    source: "NSE press release, 27 December 2005; Calcutta Stock Exchange notice, 19 January 2006",
    note: "Ratio and the later history of these companies are confirmed by your analyst; not valued here.",
  },
  {
    parent: "RELIANCE",
    recordDate: "2023-07-20",
    childSymbol: "JIOFIN",
    childName: "Jio Financial Services Limited",
    ratioFrom: 1,
    ratioTo: 1,
    source:
      "Reliance Industries record-date announcement (8 July 2023); NSE circular on the special pre-open session",
  },
  {
    parent: "ITC",
    recordDate: "2025-01-06",
    childSymbol: "ITCHOTELS",
    childName: "ITC Hotels Limited",
    ratioFrom: 10,
    ratioTo: 1,
    source: "ITC share entitlement ratio report and record-date announcement (December 2024)",
  },
  {
    parent: "TMPV",
    recordDate: "2025-10-14",
    childSymbol: "TMCV",
    childName: "Tata Motors Limited (commercial vehicles business)",
    ratioFrom: 1,
    ratioTo: 1,
    source: "Tata Motors record-date announcement (1 October 2025); exchange listing notices",
    note: "Tata Motors Limited was renamed Tata Motors Passenger Vehicles Limited (TMPV) when the commercial vehicles business was demerged.",
  },
];

/** Demergers of an NSE-listed parent, oldest first. */
export function spinOffsFor(symbol: string): SpinOff[] {
  const s = symbol.toUpperCase();
  return SPIN_OFFS.filter((x) => x.parent === s).sort((a, b) =>
    a.recordDate.localeCompare(b.recordDate),
  );
}
