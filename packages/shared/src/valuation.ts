import { computeEntitlement, type CorporateActionLike } from "./corporate-actions.js";
import { DEFAULT_SUCCESS_FEE_BPS, holdingValuePaise, netRealization } from "./fees.js";
import { spinOffsFor, type SpinOff } from "./reference/spin-offs.js";

/** One line of the multi-stock holding calculator. */
export interface HoldingInput {
  symbol: string;
  exchange: "NSE" | "BSE";
  name: string;
  /** 1980 to the current year. */
  purchaseYear: number;
  originalShares: number;
  /** Rupees per share today. */
  pricePerShare: number | null;
  /** True when the visitor typed the price instead of using the synced one. */
  priceIsManual: boolean;
}

/** One step of the corporate-action timeline, in date order. */
export interface TimelineStep {
  date: string;
  kind: "BONUS" | "SPLIT" | "MERGER" | "DEMERGER";
  /** e.g. "1:1 bonus", "Split ₹10 → ₹2", "Demerger: 1 Jio Financial Services share per 1 held". */
  label: string;
  sharesBefore: number;
  /** Shares of this company after the step (unchanged by a demerger). */
  sharesAfter: number;
  /** Demergers only: shares of the new company received (null when not valued). */
  receivedShares?: number | null;
  receivedSymbol?: string | null;
  source: string | null;
}

/** Shares of a demerged company received through a holding. */
export interface SpinOffHolding {
  recordDate: string;
  symbol: string;
  name: string;
  shares: number;
  /** Rupees per share today; null when no price is available. */
  pricePerShare: number | null;
  marketValuePaise: number | null;
}

export interface HoldingValuation extends HoldingInput {
  /** Holding is assumed from 1 January of the purchase year. */
  heldFrom: string;
  /** Bonus and split events applied. */
  events: number;
  /** Shares today if bought on 1 January of the purchase year (every event that year applies). */
  currentShares: number;
  /**
   * When events happened during the purchase year, the share count depends on
   * the purchase date: min (bought on 31 December) to max (bought on 1 January).
   */
  currentSharesRange: { min: number; max: number };
  /** Bonus/split events in the purchase year itself (the cause of the range). */
  purchaseYearEvents: number;
  growthMultiple: number;
  /** False when no corporate-action history was available: shares are not adjusted. */
  sharesAdjusted: boolean;
  /** Estimated market value; null when there is no price (never zero for unknown). */
  marketValuePaise: number | null;
  /**
   * Dividends declared while the shares were held, if every one went unpaid.
   * Historical figures, not a confirmed unpaid entitlement, and not in the estimate.
   */
  dividendPaise: number;
  /**
   * Of dividendPaise: declared in the last 7 years, so still with the company if
   * unpaid; and older, which the company must have transferred to the IEPF if
   * unpaid (Companies Act, 2013, section 124).
   */
  dividendsWithCompanyPaise: number;
  dividendsWithIepfPaise: number;
  /** Every bonus, split, merger and demerger since purchase, in date order. */
  timeline: TimelineStep[];
  /** Shares of demerged companies received, valued at their own prices. */
  spinOffs: SpinOffHolding[];
  /** Sum of the demerged holdings with a known price. */
  spinOffValuePaise: number;
  /**
   * The headline estimate: market value of these shares plus valued demerged
   * holdings. Null when the price of this stock is unknown.
   */
  totalPaise: number | null;
  /** Assumptions that apply to this line, in plain words. */
  assumptions: string[];
}

export const MIN_PURCHASE_YEAR = 1980;

/** Unpaid dividends move from the company to the IEPF after seven years. */
export const IEPF_TRANSFER_YEARS = 7;

/** Assumptions shown with every estimate, wherever it appears. */
export const VALUATION_ASSUMPTIONS = [
  "This is an estimate, not an official or certified valuation.",
  "Shares are assumed to have been held from 1 January of the purchase year.",
  "Bonuses and splits are applied in date order; fractional entitlements are left out, as companies pay cash for them.",
  "Demergers on record are valued at the new company's own price; mergers follow the swap ratio on record; other cash-only events are checked by your analyst.",
  "Dividends declared while the shares were held are estimated as if none were encashed: those from the last 7 years would still be with the company, older ones with the IEPF. Whether any went unpaid is confirmed only during verification.",
  "Prices come from market data that can be delayed; the value is fixed only when shares are credited.",
] as const;

/** Shares today, market value and dividends declared since purchase, from real event history. */
export function valueHolding(
  input: HoldingInput,
  actions: readonly CorporateActionLike[],
  dividends: readonly { exDate: string; amount: number }[],
  /** False when the stock's corporate-action history could not be loaded. */
  actionsKnown = true,
  opts: {
    /** Demergers of this stock (from SPIN_OFFS). */
    spinOffs?: readonly SpinOff[];
    /** Today's price of each demerged company, by symbol; null or absent when unknown. */
    spinOffPrices?: Readonly<Record<string, number | null | undefined>>;
    /** First date the bonus/split history is verified from, when not complete since 1980. */
    historyFrom?: string | null;
    /** Today (YYYY-MM-DD), for the 7-year IEPF rule. Defaults to the current date. */
    today?: string;
  } = {},
): HoldingValuation {
  const heldFrom = `${input.purchaseYear}-01-01`;
  const yearEnd = `${input.purchaseYear}-12-31`;
  const shareActions = actions.filter(
    (a) => a.actionType !== "DIVIDEND" && a.actionType !== "CASH_ENTITLEMENT",
  );
  const all: CorporateActionLike[] = [
    ...shareActions,
    ...dividends.map((d) => ({
      actionType: "DIVIDEND" as const,
      exDate: d.exDate,
      dividendPerShare: d.amount,
    })),
  ];
  const r = computeEntitlement(input.originalShares, all, { acquiredOn: heldFrom });
  const late = computeEntitlement(input.originalShares, shareActions, { acquiredOn: yearEnd });
  const events = shareActions.filter((a) => a.exDate >= heldFrom).length;
  const purchaseYearEvents = shareActions.filter(
    (a) => a.exDate >= heldFrom && a.exDate < yearEnd,
  ).length;
  const marketValuePaise =
    input.pricePerShare === null ? null : holdingValuePaise(r.shares, input.pricePerShare);
  const assumptions: string[] = [];
  if (!actionsKnown)
    assumptions.push(
      "No bonus or split history was available for this stock, so the share count is not adjusted.",
    );
  if (purchaseYearEvents)
    assumptions.push(
      `${purchaseYearEvents} bonus or split event${purchaseYearEvents > 1 ? "s" : ""} fell in ${input.purchaseYear}; depending on the purchase date you hold between ${late.shares.toLocaleString("en-IN")} and ${r.shares.toLocaleString("en-IN")} shares.`,
    );
  if (shareActions.some((a) => a.actionType === "MERGER" && a.exDate >= heldFrom))
    assumptions.push("A merger applies: the share count follows the swap ratio on record.");
  if (input.pricePerShare === null)
    assumptions.push("No price is available, so no value is estimated.");
  if (opts.historyFrom && heldFrom < opts.historyFrom)
    assumptions.push(
      `Bonus and split history for this stock is verified from ${opts.historyFrom.slice(0, 4)}; events before then may be missing from the share count.`,
    );

  // Timeline: share-changing steps from the replay, with demergers interleaved.
  const timeline: TimelineStep[] = r.steps
    .filter(
      (st) => st.action.actionType !== "DIVIDEND" && st.action.actionType !== "CASH_ENTITLEMENT",
    )
    .map((st) => ({
      date: st.action.exDate,
      kind: st.action.actionType as TimelineStep["kind"],
      label: actionLabel(st.action),
      sharesBefore: st.sharesBefore,
      sharesAfter: st.sharesAfter,
      source: st.action.source ?? null,
    }));
  const spinOffs: SpinOffHolding[] = [];
  for (const so of opts.spinOffs ?? []) {
    if (so.recordDate < heldFrom) continue;
    // Shares held at the close of the day before the record date.
    const held = computeEntitlement(input.originalShares, shareActions, {
      acquiredOn: heldFrom,
      asOf: dayBefore(so.recordDate),
    }).shares;
    const valued = so.childSymbol !== null && so.ratioFrom !== null && so.ratioTo !== null;
    const received = valued ? Math.floor((held * so.ratioTo!) / so.ratioFrom!) : null;
    timeline.push({
      date: so.recordDate,
      kind: "DEMERGER",
      label: valued
        ? `Demerger: ${so.ratioTo} ${shortName(so.childName)} share${so.ratioTo === 1 ? "" : "s"} for every ${so.ratioFrom} held`
        : `Demerger: shares of ${shortName(so.childName)}`,
      sharesBefore: held,
      sharesAfter: held,
      receivedShares: received,
      receivedSymbol: so.childSymbol,
      source: so.source,
    });
    if (!valued) {
      assumptions.push(
        so.note ??
          `The ${so.recordDate.slice(0, 4)} demerger is not valued here; your analyst checks it.`,
      );
      continue;
    }
    const price = opts.spinOffPrices?.[so.childSymbol!];
    const p = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
    if (received! > 0) {
      spinOffs.push({
        recordDate: so.recordDate,
        symbol: so.childSymbol!,
        name: so.childName,
        shares: received!,
        pricePerShare: p,
        marketValuePaise: p === null ? null : holdingValuePaise(received!, p),
      });
      if (p === null)
        assumptions.push(
          `No price is available for ${so.childName}, so those ${received!.toLocaleString("en-IN")} shares are not valued.`,
        );
    }
  }
  timeline.sort((a, b) => a.date.localeCompare(b.date));
  const spinOffValuePaise = spinOffs.reduce((t, x) => t + (x.marketValuePaise ?? 0), 0);

  // Dividends by the 7-year rule: recent ones stay with the company, older ones go to the IEPF.
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const cutoff = `${Number(today.slice(0, 4)) - IEPF_TRANSFER_YEARS}${today.slice(4)}`;
  let dividendsWithCompanyPaise = 0;
  let dividendsWithIepfPaise = 0;
  for (const st of r.steps)
    if (st.dividendPaise > 0) {
      if (st.action.exDate >= cutoff) dividendsWithCompanyPaise += st.dividendPaise;
      else dividendsWithIepfPaise += st.dividendPaise;
    }

  return {
    ...input,
    heldFrom,
    events,
    currentShares: r.shares,
    currentSharesRange: { min: late.shares, max: r.shares },
    purchaseYearEvents,
    growthMultiple: input.originalShares > 0 ? r.shares / input.originalShares : 0,
    sharesAdjusted: actionsKnown,
    marketValuePaise,
    dividendPaise: r.dividendPaise,
    dividendsWithCompanyPaise,
    dividendsWithIepfPaise,
    timeline,
    spinOffs,
    spinOffValuePaise,
    totalPaise: marketValuePaise === null ? null : marketValuePaise + spinOffValuePaise,
    assumptions,
  };
}

/** "ITC Hotels Limited" -> "ITC Hotels"; drops a trailing parenthetical. */
function shortName(name: string): string {
  return name
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/\s+(Limited|Ltd\.?|Private Limited)$/i, "")
    .trim();
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** "1:1 bonus", "Split ₹10 → ₹2", "Merger: 2 for every 5 held". */
export function actionLabel(a: CorporateActionLike): string {
  const from = Number(a.ratioFrom);
  const to = Number(a.ratioTo);
  switch (a.actionType) {
    case "BONUS":
      return `${to}:${from} bonus`;
    case "SPLIT":
      return `Split ₹${from} → ₹${to} face value`;
    case "MERGER":
      return `Merger: ${to} new for every ${from} held`;
    default:
      return a.notes ?? a.actionType;
  }
}

export interface PortfolioTotals {
  /** Sum of the lines with a known value. */
  totalPaise: number;
  marketValuePaise: number;
  /** Dividends declared while held (historical, not confirmed unpaid; not in totalPaise). */
  dividendPaise: number;
  dividendsWithCompanyPaise: number;
  dividendsWithIepfPaise: number;
  /** Valued shares of demerged companies (included in totalPaise). */
  spinOffValuePaise: number;
  originalShares: number;
  currentShares: number;
  growthMultiple: number;
  /** Lines whose value is unknown (no price). When above zero the total is incomplete. */
  unvaluedLines: number;
  complete: boolean;
}

export function portfolioTotals(rows: readonly HoldingValuation[]): PortfolioTotals {
  const sum = (f: (r: HoldingValuation) => number) => rows.reduce((a, r) => a + f(r), 0);
  const originalShares = sum((r) => r.originalShares);
  const currentShares = sum((r) => r.currentShares);
  const unvaluedLines = rows.filter((r) => r.totalPaise === null).length;
  return {
    totalPaise: sum((r) => r.totalPaise ?? 0),
    marketValuePaise: sum((r) => r.marketValuePaise ?? 0),
    dividendPaise: sum((r) => r.dividendPaise),
    dividendsWithCompanyPaise: sum((r) => r.dividendsWithCompanyPaise),
    dividendsWithIepfPaise: sum((r) => r.dividendsWithIepfPaise),
    spinOffValuePaise: sum((r) => r.spinOffValuePaise),
    originalShares,
    currentShares,
    growthMultiple: originalShares ? currentShares / originalShares : 0,
    unvaluedLines,
    complete: unvaluedLines === 0,
  };
}

/**
 * The calculator's net value scorecard. Every figure is an estimate:
 * dividends assume none were encashed, and our fee is applied at the
 * standard rate on value actually credited (the fee is confirmed in the
 * engagement letter before anything is signed). Statutory and documentation
 * costs (stamp duty on the indemnity bond, notarisation, courier) depend on
 * the state and the case and are charged at actuals, so they are not
 * estimated here.
 */
export interface ClaimEstimate {
  grossMarketValuePaise: number;
  accruedDividendsPaise: number;
  totalClaimablePaise: number;
  feeBps: number;
  successFeePaise: number;
  gstOnFeePaise: number;
  netPaise: number;
  /** False when some holdings have no price, so values are understated. */
  complete: boolean;
}

export function claimEstimate(
  totals: PortfolioTotals,
  feeBps = DEFAULT_SUCCESS_FEE_BPS,
): ClaimEstimate {
  const gross = totals.totalPaise;
  const dividends = totals.dividendPaise;
  const n = netRealization(gross + dividends, feeBps);
  return {
    grossMarketValuePaise: gross,
    accruedDividendsPaise: dividends,
    totalClaimablePaise: n.grossPaise,
    feeBps,
    successFeePaise: n.feePaise,
    gstOnFeePaise: n.gstPaise,
    netPaise: n.netPaise,
    complete: totals.complete,
  };
}

/** The fields of an equity's market detail that valuation needs (API and calculator alike). */
export interface EquityHistoryLike {
  exchange: "NSE" | "BSE";
  symbol: string;
  actions: readonly CorporateActionLike[];
  dividends: readonly { exDate: string; amount: number }[];
  actionsKnown: boolean;
  historyFrom?: string | null;
  spinOffs?: readonly { symbol: string | null; price: number | null }[];
}

/**
 * valueHolding with the stock's demergers and history caveat applied: the one
 * call the calculator, its quick-try pills and the PDF dossier all make.
 */
export function valueEquityHolding(
  input: HoldingInput,
  d: EquityHistoryLike,
  today?: string,
): HoldingValuation {
  return valueHolding(input, d.actions, d.dividends, d.actionsKnown, {
    spinOffs: d.exchange === "NSE" ? spinOffsFor(d.symbol) : [],
    spinOffPrices: Object.fromEntries(
      (d.spinOffs ?? []).filter((s) => s.symbol).map((s) => [s.symbol!, s.price]),
    ),
    historyFrom: d.historyFrom ?? null,
    today,
  });
}
