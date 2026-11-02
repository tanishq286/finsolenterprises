import { describe, expect, it } from "vitest";

import {
  claimEstimate,
  portfolioTotals,
  POPULAR_EXAMPLES,
  spinOffsFor,
  valueHolding,
  verifiedActionsFor,
  type HoldingValuation,
} from "../src/index.js";

const line = (
  symbol: string,
  year: number,
  shares: number,
  price: number | null,
  extra: {
    dividends?: { exDate: string; amount: number }[];
    spinOffPrices?: Record<string, number | null>;
    today?: string;
  } = {},
): HoldingValuation => {
  const v = verifiedActionsFor(symbol)!;
  return valueHolding(
    {
      symbol,
      exchange: "NSE",
      name: v.name,
      purchaseYear: year,
      originalShares: shares,
      pricePerShare: price,
      priceIsManual: false,
    },
    v.actions,
    extra.dividends ?? [],
    true,
    {
      spinOffs: spinOffsFor(symbol),
      spinOffPrices: extra.spinOffPrices,
      historyFrom: v.historyFrom,
      today: extra.today ?? "2026-11-02",
    },
  );
};

describe("corporate-action timeline", () => {
  it("Reliance, 100 shares in 1995: four 1:1 bonuses make 1,600, plus 800 Jio Financial shares", () => {
    const r = line("RELIANCE", 1995, 100, 1400, { spinOffPrices: { JIOFIN: 300 } });
    expect(r.currentShares).toBe(1600);
    expect(
      r.timeline.map((t) => [t.date.slice(0, 4), t.kind, t.sharesAfter, t.receivedShares ?? null]),
    ).toEqual([
      ["1997", "BONUS", 200, null],
      ["2006", "DEMERGER", 200, null],
      ["2009", "BONUS", 400, null],
      ["2017", "BONUS", 800, null],
      ["2023", "DEMERGER", 800, 800],
      ["2024", "BONUS", 1600, null],
    ]);
    // 2006: shares held before the record date are the 1997-adjusted 200.
    expect(r.timeline[1]!.sharesBefore).toBe(200);
    expect(r.spinOffs).toEqual([
      expect.objectContaining({ symbol: "JIOFIN", shares: 800, marketValuePaise: 800 * 300 * 100 }),
    ]);
    expect(r.marketValuePaise).toBe(1600 * 1400 * 100);
    expect(r.totalPaise).toBe(1600 * 1400 * 100 + 800 * 300 * 100);
    // The unconfirmed 2006 ratio is shown, never valued.
    expect(r.assumptions.some((a) => /analyst/i.test(a))).toBe(true);
  });

  it("ITC Hotels: 1 share per 10 ITC shares held before the record date", () => {
    const r = line("ITC", 2000, 100, 400, { spinOffPrices: { ITCHOTELS: 200 } });
    const so = r.timeline.find((t) => t.kind === "DEMERGER")!;
    expect(so.receivedShares).toBe(Math.floor(so.sharesBefore / 10));
    expect(r.spinOffs[0]!.shares).toBe(so.receivedShares);
  });

  it("Tata Motors (now TMPV), 100 in 2005: 500 after the 2011 split, plus 500 commercial-vehicle shares", () => {
    const r = line("TMPV", 2005, 100, 400, { spinOffPrices: { TMCV: 350 } });
    expect(r.currentShares).toBe(500);
    expect(r.spinOffs[0]).toMatchObject({ symbol: "TMCV", shares: 500 });
    expect(r.assumptions.some((a) => /verified from/.test(a))).toBe(false);
  });

  it("warns that Tata Motors history before 1996 is unverified", () => {
    const r = line("TMPV", 1990, 100, 400);
    expect(r.assumptions.some((a) => /verified from 1996/.test(a))).toBe(true);
  });

  it("does not value a demerged holding without a price, and says so", () => {
    const r = line("RELIANCE", 2020, 10, 1400, { spinOffPrices: {} });
    expect(r.spinOffs[0]).toMatchObject({ symbol: "JIOFIN", shares: 10, marketValuePaise: null });
    expect(r.totalPaise).toBe(r.marketValuePaise);
    expect(r.assumptions.some((a) => /No price is available for Jio/.test(a))).toBe(true);
  });

  it("skips demergers before the purchase", () => {
    expect(line("RELIANCE", 2024, 10, 1400).timeline.some((t) => t.kind === "DEMERGER")).toBe(
      false,
    );
  });
});

describe("7-year dividend split", () => {
  it("puts dividends from the last 7 years with the company and older ones with the IEPF", () => {
    const r = line("HINDUNILVR", 2010, 100, 2500, {
      today: "2026-11-02",
      dividends: [
        { exDate: "2015-06-01", amount: 10 },
        { exDate: "2019-11-01", amount: 5 },
        { exDate: "2019-11-03", amount: 5 },
        { exDate: "2025-06-01", amount: 20 },
      ],
    });
    expect(r.dividendsWithIepfPaise).toBe((10 + 5) * 100 * 100);
    expect(r.dividendsWithCompanyPaise).toBe((5 + 20) * 100 * 100);
    expect(r.dividendsWithIepfPaise + r.dividendsWithCompanyPaise).toBe(r.dividendPaise);
  });
});

describe("net value scorecard", () => {
  it("applies the success fee and GST on the fee to market value plus dividends", () => {
    const rows = [
      line("DABUR", 2000, 100, 500, { dividends: [{ exDate: "2024-01-01", amount: 2 }] }),
      line("HINDUNILVR", 1999, 100, 2500),
    ];
    const t = portfolioTotals(rows);
    const e = claimEstimate(t);
    expect(e.totalClaimablePaise).toBe(t.totalPaise + t.dividendPaise);
    expect(e.successFeePaise).toBe(Math.floor(e.totalClaimablePaise / 10));
    expect(e.gstOnFeePaise).toBe(Math.floor((e.successFeePaise * 18) / 100));
    expect(e.netPaise).toBe(e.totalClaimablePaise - e.successFeePaise - e.gstOnFeePaise);
  });

  it("never turns a missing price into ₹0 or NaN", () => {
    const r = line("DABUR", 2000, 100, null);
    expect(r.totalPaise).toBeNull();
    const e = claimEstimate(portfolioTotals([r]));
    expect(Number.isFinite(e.netPaise)).toBe(true);
    expect(e.complete).toBe(false);
  });
});

describe("quick-try examples", () => {
  it("are the six requested blue chips, each with a verified history", () => {
    expect(POPULAR_EXAMPLES.map((e) => e.symbol)).toEqual([
      "DABUR",
      "RELIANCE",
      "ITC",
      "TMPV",
      "INFY",
      "HINDUNILVR",
    ]);
    for (const e of POPULAR_EXAMPLES) expect(verifiedActionsFor(e.symbol)).not.toBeNull();
  });
});
