import { describe, expect, it } from "vitest";

import { folioVariants, normalizeCompanyQuery } from "../src/index.js";

describe("normalizeCompanyQuery", () => {
  it("drops case, punctuation and legal suffixes", () => {
    expect(normalizeCompanyQuery("The Reliance Industries Ltd.")).toBe("reliance industries");
    expect(normalizeCompanyQuery("  RELIANCE   INDUSTRIES LIMITED ")).toBe("reliance industries");
    expect(normalizeCompanyQuery("Larsen & Toubro")).toBe("larsen and toubro");
  });

  it("is capped at 80 characters and can come out empty", () => {
    expect(normalizeCompanyQuery("x".repeat(200)).length).toBeLessThanOrEqual(80);
    expect(normalizeCompanyQuery("Ltd.")).toBe("");
  });
});

describe("folioVariants", () => {
  it("tries the folio as typed and without separators", () => {
    expect(folioVariants(" RIL-0012/345.621 ")).toEqual(["RIL-0012/345.621", "RIL0012345621"]);
  });

  it("does not repeat a folio that has no separators", () => {
    expect(folioVariants("RIL0012345621")).toEqual(["RIL0012345621"]);
  });

  it("returns nothing for blank input", () => {
    expect(folioVariants("   ")).toEqual([]);
  });
});
