/**
 * Regression tests for the PDF table reader (November 2026 audit). The
 * geometry mirrors the published Dabur IEPF-2 layout, with synthetic text.
 */
import { describe, expect, it } from "vitest";

import { gutterBetween, splitRun, type PdfItem } from "../src/statement-reader.js";
import { parseRow, mapHeaders } from "../src/ingest-iepf.js";

const item = (str: string, x: number, w: number, y = 0): PdfItem => ({ str, x, w, y });

describe("splitRun", () => {
  it("splits an amount run that carries the next cell's day", () => {
    const [amount, day] = splitRun(item("1234.50 02", 728, 22));
    expect(amount!.str).toBe("1234.50");
    expect(day!.str).toBe("02");
    expect(day!.x).toBeGreaterThan(amount!.x + amount!.w);
    expect(day!.x + day!.w).toBeCloseTo(750, 0);
  });

  it("splits a digit glued to a capitalised word with no space (…-9Amount)", () => {
    const parts = splitRun(item("12345678-9Amount", 631, 40));
    expect(parts.map((p) => p.str)).toEqual(["12345678-9", "Amount"]);
  });

  it("leaves single words alone", () => {
    expect(splitRun(item("SHARMA", 238, 20))).toHaveLength(1);
  });
});

describe("gutterBetween", () => {
  // Father/Husband Last Name header spans 241-281; Address header 313-328.
  // Address data is left-set at 287 and its first word is short.
  const words: PdfItem[] = [];
  for (let i = 0; i < 40; i++) {
    words.push(item("SURNAME", 238, 30 + (i % 10)));
    words.push(item(i % 3 ? "C/O" : "12", 287, 7));
    words.push(item("SOME", 296, 14));
    words.push(item("ROAD", 311, 14));
  }

  it("puts the boundary just left of the address column, not at the header midpoint", () => {
    const b = gutterBetween(281, 313, words);
    expect(b).toBeGreaterThan(278);
    expect(b).toBeLessThan(287);
    // The old nearest-header-centre rule sent a word at 287 to the left column.
    expect((241 + 281) / 2 < 287 && 287 - (241 + 281) / 2 < (313 + 328) / 2 - 287).toBe(true);
  });

  it("anchors on the next column's text even when an empty stretch follows it", () => {
    // Address words end near 354; "INDIA" sits at 356-367; nothing from 367 to the Country header at 369.
    // Address words continue the cell after word spaces, at varying positions; only
    // "INDIA" begins a new cell, so only it is a cell start (as the reader computes).
    const street = Array.from({ length: 30 }, (_, i) => item("STREET", 318 + (i % 12), 24));
    const india = Array.from({ length: 30 }, () => item("INDIA", 356, 11));
    const b = gutterBetween(328, 369, [...street, ...india], new Set(india));
    expect(b).toBeLessThanOrEqual(356);
    expect(b).toBeGreaterThan(353);
  });
});

describe("parseRow", () => {
  const headers = [
    "Investor First Name",
    "Investor Middle Name",
    "Investor Last Name",
    "Father/Husband First Name",
    "Father/Husband Middle Name",
    "Father/Husband Last Name",
    "Address",
    "Country",
    "State",
    "District",
    "Pin Code",
    "Folio Number",
    "DP Id-Client Id-Account Number",
    "Investment Type",
    "Amount transferred",
    "Proposed Date of transfer to IEPF",
  ];
  const { map } = mapHeaders(headers);
  const row = (over: Partial<Record<string, string>>) => headers.map((h) => over[h] ?? "");
  const base = {
    "Investor First Name": "ASHA",
    "Investor Last Name": "TESTCASE",
    Address: "1 TEST LANE",
    Country: "INDIA",
    State: "DELHI",
    District: "NEW DELHI",
    "Pin Code": "110001",
    "Folio Number": "T0000001",
    "Investment Type": "Amount for unclaimed and unpaid dividend",
    "Amount transferred": "120.50",
    "Proposed Date of transfer to IEPF": "02-DEC-2019",
  };

  it("drops the NA placeholder and keeps the raw relative separately", () => {
    const r = parseRow(row({ ...base, "Father/Husband First Name": "NA" }), map, 1, "IEPF_2");
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.value.fatherOrSpouse).toBeNull();
    expect(r.value.fatherOrSpouseRaw).toBe("NA");
    expect(r.value.issues).toContain("RELATIVE_MISSING");
  });

  it("quarantines a relative with spilled address text", () => {
    const r = parseRow(
      row({ ...base, "Father/Husband First Name": "NA", "Father/Husband Last Name": "C/O" }),
      map,
      1,
      "IEPF_2",
    );
    expect(r?.ok && r.value.issues).toContain("RELATIVE_SUSPECT");
  });

  it("quarantines an amount cell holding two numbers instead of concatenating them", () => {
    const r = parseRow(row({ ...base, "Amount transferred": "120.50 02" }), map, 1, "IEPF_2");
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.issues).toEqual(["AMOUNT_AMBIGUOUS"]);
  });

  it("reads a date with a header remnant before it", () => {
    const r = parseRow(
      row({ ...base, "Proposed Date of transfer to IEPF": "(DD-MON-YYYY) 02-DEC-2019" }),
      map,
      1,
      "IEPF_2",
    );
    expect(r?.ok && r.value.eventDate?.toISOString().slice(0, 10)).toBe("2019-12-02");
  });

  it("carries the reader's wrapped-name note into a quarantining issue", () => {
    const r = parseRow(row(base), map, 1, "IEPF_2", ["WRAPPED_NAME"]);
    expect(r?.ok && r.value.issues).toContain("WRAPPED_NAME");
  });
});

describe("November 2026: folio-led statements (Ashok Leyland layout)", () => {
  it("does not take a PIN printed as its own run for the edge of a right-aligned amount column", () => {
    // Address header ends at 344; "Dividend Amount" header spans 433-470.
    // Addresses run up to ~430; a few PINs start at 348-389 after a gap;
    // every amount starts at 441-449, inside its own header.
    const words: PdfItem[] = [];
    const starts = new Set<PdfItem>();
    for (let i = 0; i < 60; i++) {
      words.push(item("ADDRESS", 246, 160 + (i % 25)));
      const amt = item("950.00", 441 + (i % 9), 22);
      words.push(amt);
      starts.add(amt);
      if (i % 6 === 0) {
        const pin = item("226001", 348 + (i % 3) * 20, 22);
        words.push(pin);
        starts.add(pin);
      }
    }
    const b = gutterBetween(344, 433, words, starts, 470);
    expect(b).toBeGreaterThan(420);
    expect(b).toBeLessThanOrEqual(441);
  });

  it("maps 'Dividend Amount (Rs.)' and the misprinted 'Father / Husbank Name' headers", () => {
    const { map } = mapHeaders([
      "Folio / Demat Account No.",
      "Shareholder Name (First / Middle / Last)",
      "Father / Husbank Name (First / Middle / Last)",
      "Address",
      "Dividend Amount (Rs.)",
      "Proposed Date of transfer to IEPF",
    ]);
    expect(map).toMatchObject({
      folio: 0,
      fullName: 1,
      fatherFull: 2,
      address: 3,
      amount: 4,
      eventDate: 5,
    });
  });

  const headers = [
    "Folio / Demat Account No.",
    "Shareholder Name",
    "Father / Husband Name",
    "Address",
    "Dividend Amount (Rs.)",
    "Proposed Date of transfer to IEPF",
  ];
  const { map } = mapHeaders(headers);
  const row = (folio: string, address = "50/229, HALSEY ROAD, KANPUR 208001") => [
    folio,
    "ASHA TESTCASE",
    "RAM TESTCASE",
    address,
    "475.00",
    "27-AUG-2023",
  ];

  it("reads the PIN from the end of the address when there is no PIN column", () => {
    const r = parseRow(row("3739"), map, 1, "IEPF_2");
    expect(r?.ok && r.value).toMatchObject({ pincode: "208001", state: "UTTAR_PRADESH" });
    expect(r?.ok && r.value.issues).not.toContain("PIN_MISSING");
  });

  it("quarantines a demat account number the source cut off, but not an IN-prefixed physical folio", () => {
    for (const cut of ["IN30011810", "IN30226", "1201060000"]) {
      const r = parseRow(row(cut), map, 1, "IEPF_2");
      expect(r && !r.ok && r.issues).toEqual(["FOLIO_INCOMPLETE"]);
    }
    for (const whole of ["IN30001110430949", "1201750200040637", "IN0170", "36966"]) {
      expect(parseRow(row(whole), map, 1, "IEPF_2")?.ok).toBe(true);
    }
  });

  it("treats a continued name in a folio-led table as a warning, not a quarantine", () => {
    const r = parseRow(row("3765"), map, 1, "IEPF_2", ["NAME_CONTINUED"]);
    expect(r?.ok && r.value.issues).toContain("NAME_CONTINUED");
    expect(r?.ok && r.value.issues).not.toContain("WRAPPED_NAME");
  });
});

describe("November 2026: PIN printed in the folio column (columns shifted in the source)", () => {
  const headers = [
    "Investor First Name",
    "Investor Last Name",
    "Address",
    "State",
    "Pin Code",
    "Folio Number",
    "DP Id-Client Id- Account Number",
    "Number of shares",
  ];
  const { map } = mapHeaders(headers);
  const row = (pin: string, folio: string, demat: string) => [
    "ASHA",
    "TESTCASE",
    "1 TEST LANE",
    "KARNATAKA",
    pin,
    folio,
    demat,
    "50",
  ];

  it("moves the PIN out and keeps the demat account as the identifier", () => {
    const r = parseRow(row("", "591170", "C12010600-12010600-00488378"), map, 1, "IEPF_4");
    expect(r?.ok && r.value).toMatchObject({
      folio: "C12010600-12010600-00488378",
      pincode: "591170",
    });
    expect(r?.ok && r.value.issues).toContain("PIN_IN_FOLIO");
  });

  it("splits a PIN glued to a physical folio", () => {
    const r = parseRow(row("", "678007PRCM009980", ""), map, 1, "IEPF_4");
    expect(r?.ok && r.value).toMatchObject({ folio: "PRCM009980", pincode: "678007" });
  });

  it("leaves a six-digit folio alone when the PIN column is filled", () => {
    const r = parseRow(row("560001", "100100", ""), map, 1, "IEPF_4");
    expect(r?.ok && r.value).toMatchObject({ folio: "100100", pincode: "560001" });
  });
});
