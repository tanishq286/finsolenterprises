import { describe, expect, it } from "vitest";

import {
  actionCount,
  exampleYearFor,
  holdingKey,
  syncedText,
  upsertHolding,
} from "../lib/calculator";
import { companyDisplayName, statementYears } from "../lib/format";
import { letterSections } from "../lib/directory";

describe("calculator holdings", () => {
  it("updates the card for the same company and purchase year instead of duplicating it", () => {
    // Arrange
    const first = { key: holdingKey("NSE", "RELIANCE", 1995), shares: 100 };
    const other = { key: holdingKey("NSE", "ITC", 2000), shares: 100 };
    // Act
    const added = upsertHolding([first, other], { key: first.key, shares: 250 });
    // Assert
    expect(added.updated).toBe(true);
    expect(added.rows).toHaveLength(2);
    expect(added.rows[0]).toEqual({ key: first.key, shares: 250 });
  });

  it("adds a new card for a different purchase year of the same company", () => {
    const rows = [{ key: holdingKey("NSE", "RELIANCE", 1995) }];
    const next = upsertHolding(rows, { key: holdingKey("NSE", "RELIANCE", 2005) });
    expect(next.updated).toBe(false);
    expect(next.rows).toHaveLength(2);
    expect(rows).toHaveLength(1); // never mutates the old list
  });

  it("counts every timeline step, demergers included, and never the purchase", () => {
    const v = {
      timeline: [
        { kind: "BONUS" },
        { kind: "SPLIT" },
        { kind: "DEMERGER" },
      ] as unknown as Parameters<typeof actionCount>[0]["timeline"],
    };
    expect(actionCount(v)).toBe(3);
  });

  it("says 'Updated just now' for a minute after a sync", () => {
    expect(syncedText(1_000, 30_000)).toBe("Updated just now");
    expect(syncedText(0, 61_000)).toMatch(/^Updated at /);
  });
});

describe("company example year", () => {
  it("never shows a 1995 purchase for a company whose records start later", () => {
    // TCS-like: first dividend 2004, bonuses 2006 and 2009.
    const r = exampleYearFor([
      { exDate: "2006-05-31" },
      { exDate: "2004-10-20" },
      { exDate: "2009-06-16" },
    ]);
    expect(r).toEqual({ year: 2004, fromRecords: true });
  });

  it("keeps 1995 when records go back further or are missing", () => {
    expect(exampleYearFor([{ exDate: "1987-01-01" }])).toEqual({ year: 1995, fromRecords: false });
    expect(exampleYearFor([])).toEqual({ year: 1995, fromRecords: false });
  });
});

describe("company display names", () => {
  it("title-cases names written in capitals and keeps acronyms", () => {
    expect(companyDisplayName("TATA CONSUMER PRODUCTS LIMITED")).toBe(
      "Tata Consumer Products Limited",
    );
    expect(companyDisplayName("ITC LIMITED")).toBe("ITC Limited");
    expect(companyDisplayName("HDFC BANK LTD")).toBe("HDFC Bank Ltd");
    expect(companyDisplayName("BHARAT PETROLEUM CORPORATION LIMITED")).toBe(
      "Bharat Petroleum Corporation Limited",
    );
    expect(companyDisplayName("STATE BANK OF INDIA")).toBe("State Bank of India");
    expect(companyDisplayName("ENGINEERS INDIA (EIL)")).toBe("Engineers India (EIL)");
  });

  it("leaves names that are already mixed case alone", () => {
    expect(companyDisplayName("Dabur India Limited")).toBe("Dabur India Limited");
    expect(companyDisplayName("3M India Limited")).toBe("3M India Limited");
  });
});

describe("statement period covered", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  it("never shows a future year", () => {
    expect(statementYears(2010, 2032, null, now)).toBe("2010–2026");
  });

  it("stops at the year the latest statement was published", () => {
    expect(statementYears(2010, 2032, "2025-08-01T00:00:00Z", now)).toBe("2010–2025");
  });

  it("collapses to one year and reports unknown periods", () => {
    expect(statementYears(2019, 2019, null, now)).toBe("2019");
    expect(statementYears(null, null, null, now)).toBe("Not known");
  });
});

describe("company directory letter sections", () => {
  const names = (...xs: string[]) => xs.map((name) => ({ name }));

  it("merges neighbouring sparse letters so no section is a lone card", () => {
    const s = letterSections(
      names("Aarti", "Ambuja", "Asian Paints", "Jindal", "Kajaria", "Lupin"),
    );
    expect(s.map((x) => x.label)).toEqual(["A", "J–L"]);
    expect(s.every((x) => x.items.length >= 3)).toBe(true);
  });

  it("folds a short tail into the section before it", () => {
    const s = letterSections(names("Aarti", "Ambuja", "Asian Paints", "Zydus"));
    expect(s).toHaveLength(1);
    expect(s[0]!.label).toBe("A–Z");
    expect(s[0]!.letters).toEqual(["A", "Z"]);
  });
});
