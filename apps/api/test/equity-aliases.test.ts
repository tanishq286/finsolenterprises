import { describe, expect, it } from "vitest";

import { aliasKey, symbolsForAlias } from "../src/market/equity-aliases.js";

describe("equity nicknames", () => {
  it("resolves the nicknames people type for large listings", () => {
    expect(symbolsForAlias("SBI")).toEqual(["SBIN"]);
    expect(symbolsForAlias("hul")).toEqual(["HINDUNILVR"]);
    expect(symbolsForAlias("RIL")).toEqual(["RELIANCE"]);
    expect(symbolsForAlias("L&T")).toEqual(["LT"]);
    expect(symbolsForAlias("l & t")).toEqual(["LT"]);
    expect(symbolsForAlias("M&M")).toEqual(["M&M"]);
    expect(symbolsForAlias("Dr. Reddy's")).toEqual(["DRREDDY"]);
    expect(symbolsForAlias("Tata Motors")).toEqual(["TMPV", "TMCV"]);
  });

  it("returns nothing for ordinary text, so normal search carries on", () => {
    expect(symbolsForAlias("Dabur")).toEqual([]);
    expect(symbolsForAlias("")).toEqual([]);
    expect(symbolsForAlias("   ")).toEqual([]);
  });

  it("normalises case, spaces and punctuation", () => {
    expect(aliasKey(" Bajaj  Finance ")).toBe("BAJAJFINANCE");
    expect(aliasKey("l&t")).toBe("LT");
  });
});
