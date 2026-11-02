import { describe, expect, it } from "vitest";
import {
  applyAction,
  canAdvanceRecoverStep,
  companySlug,
  computeEntitlement,
  documentChecklist,
  entitlementRangeForDecade,
  INDIAN_STATES,
  maskCompanyName,
  maskFolio,
  netRealization,
  normalizeIndianMobile,
  normalizeName,
  parseIndianState,
  phoneticKey,
  REFERENCE_COMPANIES,
  referenceCompanyBySlug,
  resolveSearch,
  SERVICE_VERTICALS,
  splitName,
  canonicalNameParts,
  countsShareValue,
  isDividendListing,
  numberToIndianWords,
  POPULAR_EXAMPLES,
  rupeesInWords,
  SERVICE_STEPS,
  serviceStepFor,
  valueHolding,
  verifiedActionsFor,
} from "../src/index.js";

describe("states", () => {
  it("has 36 states and union territories plus outside India", () => {
    expect(INDIAN_STATES).toHaveLength(37);
    expect(new Set(INDIAN_STATES).size).toBe(37);
  });
  it("parses filing spellings", () => {
    expect(parseIndianState("Maharashtra")).toBe("MAHARASHTRA");
    expect(parseIndianState("NCT of Delhi")).toBe("DELHI");
    expect(parseIndianState("ORISSA")).toBe("ODISHA");
    expect(parseIndianState("Jammu & Kashmir")).toBe("JAMMU_AND_KASHMIR");
    expect(parseIndianState("Foreign")).toBe("OUT_OF_INDIA");
    expect(parseIndianState("Atlantis")).toBeNull();
  });
});

describe("names", () => {
  it("strips honorifics and punctuation", () => {
    expect(normalizeName("  Smt. kamla  devi-AGARWAL ")).toBe("KAMLA DEVI AGARWAL");
    expect(normalizeName("Late Shri R.K. Gupta")).toBe("R K GUPTA");
  });
  it("splits into parts", () => {
    expect(splitName("Ramesh Kumar Agarwal")).toEqual({
      first: "RAMESH",
      middle: "KUMAR",
      last: "AGARWAL",
      full: "RAMESH KUMAR AGARWAL",
    });
  });
  it("gives transliteration variants one key", () => {
    const key = phoneticKey("Agarwal");
    expect(phoneticKey("Agrawal")).toBe(key);
    expect(phoneticKey("Aggarwal")).toBe(key);
    expect(phoneticKey("Srivastava")).toBe(phoneticKey("Shrivastav"));
    expect(phoneticKey("Chaudhary")).toBe(phoneticKey("Choudhari"));
    expect(phoneticKey("Chowdhury")).toBe(phoneticKey("Chaudhary"));
    expect(phoneticKey("Agarwal")).not.toBe(phoneticKey("Gupta"));
  });
});

describe("masking", () => {
  it("masks distinctive words of the company name", () => {
    expect(maskCompanyName("Reliance Industries Ltd")).toBe("R******e Industries Ltd");
    expect(maskCompanyName("Tata Consultancy Services Ltd")).toBe("T**a C*********y Services Ltd");
    expect(maskCompanyName("State Bank of India")).toBe("S***e Bank of India");
  });
  it("always masks something", () => {
    expect(maskCompanyName("India Industries Ltd")).toBe("I***a Industries Ltd");
  });
  it("masks folios without revealing most characters", () => {
    expect(maskFolio("RIL0012345621")).toBe("RIL***21");
    const short = maskFolio("A0012345");
    expect(short.replace(/\*/g, "").length).toBeLessThanOrEqual(4);
    expect(maskFolio("1234")).toBe("****");
  });
  it("normalises Indian mobiles", () => {
    expect(normalizeIndianMobile("098765 43210")).toBe("+919876543210");
    expect(normalizeIndianMobile("+91-98765-43210")).toBe("+919876543210");
    expect(normalizeIndianMobile("12345")).toBeNull();
    expect(normalizeIndianMobile("5876543210")).toBeNull();
  });
});

describe("corporate actions", () => {
  it("applies bonus, split and merger ratios, rounding down", () => {
    expect(
      applyAction(100, { actionType: "BONUS", exDate: "2017-01-01", ratioFrom: 1, ratioTo: 1 }),
    ).toBe(200);
    expect(
      applyAction(101, { actionType: "BONUS", exDate: "2017-01-01", ratioFrom: 2, ratioTo: 1 }),
    ).toBe(151);
    expect(
      applyAction(100, { actionType: "SPLIT", exDate: "2017-01-01", ratioFrom: 10, ratioTo: 2 }),
    ).toBe(500);
    expect(
      applyAction(7, { actionType: "MERGER", exDate: "2017-01-01", ratioFrom: 5, ratioTo: 2 }),
    ).toBe(2);
  });
  it("replays Reliance's four 1:1 bonuses for a 1990 holder", () => {
    const ril = referenceCompanyBySlug("reliance-industries-limited")!;
    const r = computeEntitlement(100, ril.actions, { acquiredOn: "1990-01-01" });
    expect(r.shares).toBe(1600);
  });
  it("only applies actions after the acquisition date", () => {
    const ril = referenceCompanyBySlug("reliance-industries-limited")!;
    expect(computeEntitlement(100, ril.actions, { acquiredOn: "2010-01-01" }).shares).toBe(400);
  });
  it("counts dividends on the shares held at each ex-date", () => {
    const r = computeEntitlement(
      100,
      [
        { actionType: "DIVIDEND", exDate: "2020-01-01", dividendPerShare: 5 },
        { actionType: "BONUS", exDate: "2021-01-01", ratioFrom: 1, ratioTo: 1 },
        { actionType: "DIVIDEND", exDate: "2022-01-01", dividendPerShare: 2.5 },
      ],
      { acquiredOn: "2000-01-01", dividendsFrom: "2019-01-01" },
    );
    expect(r.dividendPaise).toBe(100 * 500 + 200 * 250);
  });
  it("gives a range, not a guess, when only the decade is known", () => {
    const wipro = referenceCompanyBySlug("wipro-limited")!;
    const range = entitlementRangeForDecade(100, 2000, wipro.actions);
    expect(range.low.shares).toBe(884); // bought end of 2009: 2010 (2:3), 2017 (1:1), 2019 (1:3), 2024 (1:1)
    expect(range.high.shares).toBe(5332); // plus 2004 (2:1) and 2005 (1:1)
  });
});

describe("fees", () => {
  it("rounds the fee down and adds GST on the fee", () => {
    const r = netRealization(10_00_000_00, 1000);
    expect(r.feePaise).toBe(1_00_000_00);
    expect(r.gstPaise).toBe(18_000_00);
    expect(r.netPaise).toBe(10_00_000_00 - 1_18_000_00);
  });
});

describe("R.E.C.O.V.E.R.", () => {
  it("moves one step at a time and gates filing on eSign", () => {
    expect(canAdvanceRecoverStep(1, 2, { esignSigned: false, srnFiled: false }).ok).toBe(true);
    expect(canAdvanceRecoverStep(1, 3, { esignSigned: false, srnFiled: false }).ok).toBe(false);
    expect(canAdvanceRecoverStep(3, 2, { esignSigned: false, srnFiled: false }).ok).toBe(false);
    expect(canAdvanceRecoverStep(5, 6, { esignSigned: false, srnFiled: false }).ok).toBe(false);
    expect(canAdvanceRecoverStep(5, 6, { esignSigned: true, srnFiled: false }).ok).toBe(true);
    expect(canAdvanceRecoverStep(6, 7, { esignSigned: true, srnFiled: false }).ok).toBe(false);
  });
  it("adds heir documents for a deceased holder", () => {
    const docs = documentChecklist({ scenario: "DECEASED_TRANSMISSION" }).map((d) => d.docType);
    expect(docs).toContain("DEATH_CERTIFICATE");
    expect(docs).toContain("LEGAL_HEIR_OR_SUCCESSION_CERT");
    expect(documentChecklist({ scenario: "STANDARD_IEPF5" }).map((d) => d.docType)).not.toContain(
      "DEATH_CERTIFICATE",
    );
  });
});

describe("search contract", () => {
  it("resolves the four search modes", () => {
    expect(
      resolveSearch({ firstName: "Ramesh", middleName: "K", lastName: "Agarwal", state: "DELHI" })
        ?.mode,
    ).toBe("FULL");
    expect(resolveSearch({ firstName: "Ramesh", state: "DELHI" })?.mode).toBe("FIRST");
    expect(resolveSearch({ middleName: "Kumar", state: "DELHI" })?.mode).toBe("MIDDLE");
    expect(resolveSearch({ lastName: "Agarwal", state: "DELHI" })?.mode).toBe("LAST");
    expect(resolveSearch({ fullName: "Shri Ramesh Agarwal", state: "DELHI" })).toMatchObject({
      mode: "FULL",
      first: "RAMESH",
      last: "AGARWAL",
    });
    expect(resolveSearch({ state: "DELHI" })).toBeNull();
  });
});

describe("reference data", () => {
  it("holds the 15 verified companies, each with a nodal officer and no price", () => {
    expect(REFERENCE_COMPANIES).toHaveLength(15);
    expect(new Set(REFERENCE_COMPANIES.map((c) => c.slug)).size).toBe(15);
    expect(new Set(REFERENCE_COMPANIES.map((c) => c.isin)).size).toBe(15);
    for (const c of REFERENCE_COMPANIES) {
      expect(companySlug(c.name)).toBe(c.slug);
      expect(c.isin).toMatch(/^INE[0-9A-Z]{9}$/);
      expect(c.nodalOfficer.name.length).toBeGreaterThan(3);
      expect(c.contactsVerifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (c.cin) expect(c.cin).toMatch(/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/);
      else expect(c.statutoryBasis).toBeTruthy();
      expect(c).not.toHaveProperty("currentMarketPrice");
      for (const a of c.actions) expect(a.source).toBeTruthy();
    }
  });
  it("applies Bajaj Finance's split-plus-bonus pairs (100x since 2010)", () => {
    const bf = referenceCompanyBySlug("bajaj-finance-limited")!;
    expect(computeEntitlement(100, bf.actions, { acquiredOn: "2010-01-01" }).shares).toBe(10_000);
  });
  it("counts TVS Motor's redeemed preference shares as cash, not shares", () => {
    const tvs = referenceCompanyBySlug("tvs-motor-company-limited")!;
    const r = computeEntitlement(100, tvs.actions, { acquiredOn: "2000-01-01" });
    expect(r.shares).toBe(2000);
    expect(r.cashPaise).toBe(2000 * 4240);
    expect(r.dividendPaise).toBe(0);
  });
  it("has the eleven service verticals", () => {
    expect(SERVICE_VERTICALS).toHaveLength(11);
  });
});

describe("Finsol: words, calculator examples and service steps", () => {
  it("writes amounts in the Indian system", () => {
    expect(numberToIndianWords(0)).toBe("Zero");
    expect(numberToIndianWords(7_712_345)).toBe(
      "Seventy Seven Lakh Twelve Thousand Three Hundred Forty Five",
    );
    expect(numberToIndianWords(1_23_45_67_890)).toBe(
      "One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety",
    );
    expect(rupeesInWords(1_00_050)).toBe("Rupees One Thousand and Fifty Paise Only");
  });

  it("computes every one-click example from verified bonus and split history", () => {
    const shares = Object.fromEntries(
      POPULAR_EXAMPLES.map((e) => {
        const v = verifiedActionsFor(e.symbol)!;
        const r = valueHolding(
          {
            symbol: e.symbol,
            exchange: "NSE",
            name: v.name,
            purchaseYear: e.year,
            originalShares: e.shares,
            pricePerShare: 100,
            priceIsManual: true,
          },
          v.actions,
          [],
        );
        return [e.symbol, r.currentShares];
      }),
    );
    // Checked by hand against each company's recorded bonuses and splits.
    expect(shares).toEqual({
      DABUR: 600, // 2000: 1:1 (2006), 1:2 (2007), 1:1 (2010)
      RELIANCE: 1600, // 1995: 1:1 bonuses in 1997, 2009, 2017, 2024
      ITC: 4500, // 2000: 1:2 bonus and ₹10→₹1 split (2005), 1:1 (2010), 1:2 (2016)
      TMPV: 500, // 2005: ₹10→₹2 split (2011)
      INFY: 25600, // 1998: 1:1, ₹10→₹5, 3:1, then four 1:1 bonuses
      HINDUNILVR: 1000, // 1999: ₹10→₹1 split (2000)
    });
  });

  it("counts dividends on the shares held at each ex-date", () => {
    const v = valueHolding(
      {
        symbol: "X",
        exchange: "NSE",
        name: "X",
        purchaseYear: 2010,
        originalShares: 100,
        pricePerShare: 10,
        priceIsManual: false,
      },
      [{ actionType: "BONUS", exDate: "2015-01-01", ratioFrom: 1, ratioTo: 1 }],
      [
        { exDate: "2009-06-01", amount: 5 },
        { exDate: "2012-06-01", amount: 2 },
        { exDate: "2016-06-01", amount: 1.5 },
      ],
    );
    expect(v).toMatchObject({ currentShares: 200, events: 1, marketValuePaise: 200_000 });
    expect(v.dividendPaise).toBe(100 * 200 + 200 * 150);
  });

  it("maps the seven internal steps onto the four public ones", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(serviceStepFor)).toEqual([1, 2, 2, 2, 3, 3, 4]);
    expect(SERVICE_STEPS.map((s) => s.title)).toEqual([
      "3-Minute Check",
      "Portfolio Verification",
      "Complete Paperwork & Legal Execution by Finsol",
      "Direct Demat & Bank Credit",
    ]);
  });
});

describe("canonicalNameParts", () => {
  it("re-splits a whole name stored in the first column", () => {
    expect(canonicalNameParts({ first: "Namita Maji" })).toEqual({
      first: "NAMITA",
      middle: "",
      last: "MAJI",
    });
    expect(canonicalNameParts({ first: "MUKESH KUMAR KOTHARI", middle: "", last: "" })).toEqual({
      first: "MUKESH",
      middle: "KUMAR",
      last: "KOTHARI",
    });
  });

  it("moves a surname stored as the middle name into the last name", () => {
    expect(canonicalNameParts({ first: "MANPREET", middle: "KANG", last: null })).toEqual({
      first: "MANPREET",
      middle: "",
      last: "KANG",
    });
    // Matches how search splits the same name typed as one string.
    const typed = splitName("P Rajasekharan");
    expect(canonicalNameParts({ first: "P", middle: "RAJASEKHARAN" })).toEqual({
      first: typed.first,
      middle: typed.middle,
      last: typed.last,
    });
  });

  it("leaves names that already have a last name, and single names, alone", () => {
    expect(canonicalNameParts({ first: "RAMESH", middle: "KUMAR", last: "AGARWAL" })).toEqual({
      first: "RAMESH",
      middle: "KUMAR",
      last: "AGARWAL",
    });
    expect(canonicalNameParts({ first: "LAKSHMI" })).toEqual({
      first: "LAKSHMI",
      middle: "",
      last: "",
    });
  });
});

describe("countsShareValue", () => {
  it("counts shares with the IEPF, due for transfer, or in suspense", () => {
    for (const custodyStatus of ["IEPF_AUTHORITY", "DUE_FOR_IEPF_TRANSFER", "COMPANY_SUSPENSE"])
      expect(countsShareValue({ custodyStatus, investmentType: null, shares: 100 })).toBe(true);
    expect(
      countsShareValue({
        custodyStatus: "COMPANY_SUSPENSE",
        investmentType: "Shares Number of underlying Shares",
        shares: 50,
      }),
    ).toBe(true);
  });

  it("never counts the shares behind an unclaimed dividend", () => {
    for (const investmentType of [
      "Amount for unpaid and unclaimed dividend",
      "AMOUNT REFUNDED FROM THE UNPAID DIVIDEND ACCOUNT",
      "unpaid dividend",
    ])
      expect(
        countsShareValue({ custodyStatus: "COMPANY_SUSPENSE", investmentType, shares: 93_651 }),
      ).toBe(false);
    expect(isDividendListing("AMOUNT FOR UNPAID AND UNCLAIMED DIVIDEND")).toBe(true);
  });

  it("does not count dormant physical holdings or rows without shares", () => {
    expect(
      countsShareValue({ custodyStatus: "PHYSICAL_DORMANT", investmentType: null, shares: 400 }),
    ).toBe(false);
    expect(
      countsShareValue({ custodyStatus: "IEPF_AUTHORITY", investmentType: null, shares: 0 }),
    ).toBe(false);
  });
});
