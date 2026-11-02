import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  BRAND,
  BRAND_EMAILS,
  rupeesInWords,
  VALUATION_ASSUMPTIONS,
  type ClaimEstimate,
  type HoldingValuation,
  type PortfolioTotals,
} from "@finsol/shared";

const INK = rgb(0.07, 0.1, 0.16);
const MUTED = rgb(0.35, 0.4, 0.48);
const ACCENT = rgb(0.02, 0.45, 0.65);
const RULE = rgb(0.84, 0.87, 0.91);
const WASH = rgb(0.95, 0.97, 0.99);

/** Standard PDF fonts cannot draw the rupee sign, so amounts say "Rs." */
const rs = (paise: number | null) =>
  paise === null
    ? "Not available"
    : `Rs. ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const count = (n: number) => n.toLocaleString("en-IN");
/** Standard fonts cover WinAnsi only: replace what they cannot draw. */
const ascii = (s: string) =>
  s
    .replace(/₹/g, "Rs.")
    .replace(/→/g, "->")
    .replace(/–/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    // WinAnsi also covers the middle dot and the em dash.
    .replace(/[^\x20-\x7E\xB7\u2014]/g, "");

export interface ValuationReportInput {
  reportCode: string;
  issuedAt: Date;
  preparedFor: { name: string; phoneMasked: string; email: string | null };
  rows: HoldingValuation[];
  totals: PortfolioTotals;
  estimate: ClaimEstimate;
  /** Per row: the price's status, source, quote time and fetch time. */
  priceNotes: string[];
  /** Latest exchange quote time across the holdings, if any. */
  pricesAsOf: Date | null;
}

/** Documents a recovery needs; Finsol prepares and files the claim itself. */
export const DOSSIER_CHECKLIST: { heading: string; items: string[] }[] = [
  {
    heading: "Claimant KYC",
    items: [
      "PAN card and Aadhaar of the claimant (self-attested)",
      "Address proof matching the company's records, or proof of the change of address",
      "Cancelled cheque or bank statement (name, account number, IFSC)",
      "Demat account Client Master List for the credit of shares",
    ],
  },
  {
    heading: "Holding evidence",
    items: [
      "Share certificates, dividend warrants or old correspondence, if available",
      "Folio number or DP ID - client ID, if known (we trace it if not)",
    ],
  },
  {
    heading: "Claim filing (prepared and filed by Finsol Enterprises)",
    items: [
      "Statutory Authority Claim & RTA Verification Filing (Prepared & Executed by Finsol), for shares and dividends already transferred",
      "Indemnity bond on stamp paper, notarised (stamp duty as per your state)",
      "Advance receipt and the company's entitlement letter",
      "Claim to the company directly, for dividends from the last 7 years still with it",
    ],
  },
  {
    heading: "Succession (if the shareholder has passed away)",
    items: [
      "Death certificate of the shareholder",
      "Will with probate, letter of administration or succession certificate, as the value and state require",
      "Legal heir certificate, family tree and no-objection letters from other heirs, where accepted",
      "Our advisory confirms which of these apply before anything is filed",
    ],
  },
];

export const DOSSIER_NEXT_STEPS = [
  "Run the free 3-Minute Check at finsolenterprises.com to match the family's names against unclaimed records.",
  "A Finsol analyst calls to verify the holding, folio and custody (company or IEPF) - at no cost.",
  "You receive an engagement letter confirming the fee before anything is signed. No upfront fee.",
  "We collect the documents above, prepare every form and file the claim on your behalf.",
  "We follow up with the company and the IEPF Authority until the shares and dividends are credited.",
];

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: (page: PDFPage) => void,
  ) {
    this.newPage();
  }
  static readonly W = 595;
  static readonly H = 842;
  static readonly M = 44;
  newPage() {
    this.page = this.doc.addPage([Writer.W, Writer.H]);
    this.footer(this.page);
    this.y = Writer.H - Writer.M;
  }
  need(h: number) {
    if (this.y - h < 64) this.newPage();
  }
  text(s: string, x: number, size = 9, f = this.font, color = INK) {
    this.page.drawText(ascii(s), { x, y: this.y, size, font: f, color });
  }
  /** Wraps a paragraph to the width, moving down line by line. */
  para(
    s: string,
    x = Writer.M,
    width = Writer.W - 2 * Writer.M,
    size = 9,
    f = this.font,
    color = INK,
    gap = 3,
  ) {
    const words = ascii(s).split(/\s+/);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && line) {
        this.need(size + gap);
        this.text(line, x, size, f, color);
        this.y -= size + gap;
        line = w;
      } else line = next;
    }
    if (line) {
      this.need(size + gap);
      this.text(line, x, size, f, color);
      this.y -= size + gap;
    }
  }
  rule() {
    this.page.drawLine({
      start: { x: Writer.M, y: this.y },
      end: { x: Writer.W - Writer.M, y: this.y },
      thickness: 0.6,
      color: RULE,
    });
  }
  heading(s: string) {
    this.need(40);
    this.y -= 10;
    this.text(s, Writer.M, 13, this.bold, ACCENT);
    this.y -= 8;
    this.rule();
    this.y -= 14;
  }
}

export async function buildValuationPdf(r: ValuationReportInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Valuation Dossier ${r.reportCode}`);
  doc.setAuthor(BRAND.name);
  doc.setSubject("Estimated value of old shareholdings and the recovery route");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const footer = (page: PDFPage) => {
    page.drawText(
      ascii(
        `${BRAND.name}  ·  ${BRAND_EMAILS.claims}  ·  ${BRAND.domain}  ·  Report ${r.reportCode}`,
      ),
      { x: Writer.M, y: 30, size: 7.5, font, color: MUTED },
    );
    page.drawText(ascii(BRAND.promise.join("  ·  ")), {
      x: Writer.M,
      y: 20,
      size: 7.5,
      font: bold,
      color: ACCENT,
    });
  };
  const w = new Writer(doc, font, bold, footer);
  const M = Writer.M;
  const right = Writer.W - M;
  const ist = (d: Date) =>
    `${d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;

  // ── Cover block
  w.text(BRAND.name, M, 14, bold, ACCENT);
  w.text(
    `Report ID ${r.reportCode}`,
    right - bold.widthOfTextAtSize(`Report ID ${r.reportCode}`, 9),
    9,
    bold,
  );
  w.y -= 14;
  w.text(BRAND.tagline, M, 8, font, MUTED);
  const issued = `Issued ${ist(r.issuedAt)}`;
  w.text(issued, right - font.widthOfTextAtSize(ascii(issued), 8), 8, font, MUTED);
  w.y -= 34;
  w.text("Valuation Dossier", M, 22, bold);
  w.y -= 18;
  w.text("Estimated value of old shareholdings, and how Finsol recovers them", M, 10, font, MUTED);
  w.y -= 16;
  w.text(
    `Prepared for ${r.preparedFor.name} (${r.preparedFor.phoneMasked}${r.preparedFor.email ? `, ${r.preparedFor.email}` : ""})`,
    M,
    9,
    font,
    MUTED,
  );
  w.y -= 12;
  w.text(
    r.pricesAsOf
      ? `Market prices as of ${ist(r.pricesAsOf)} (latest exchange quote time among the holdings)`
      : "Market prices: see each holding below for its price time",
    M,
    9,
    font,
    MUTED,
  );

  // ── Scorecard
  w.heading("Value scorecard (estimate)");
  const e = r.estimate;
  const lines: [string, string, boolean?][] = [
    [
      "Gross current market value (adjusted shares x current price, incl. demerged holdings)",
      rs(e.grossMarketValuePaise),
    ],
    [
      `Estimated accrued dividends (if none were encashed): ${rs(r.totals.dividendsWithCompanyPaise)} with the companies (last 7 years), ${rs(r.totals.dividendsWithIepfPaise)} with the IEPF`,
      rs(e.accruedDividendsPaise),
    ],
    ["Total Claimable Wealth", rs(e.totalClaimablePaise), true],
    ["Success-Based Fee: Custom (Zero Upfront — Quoted per Engagement Letter)", "Custom"],
    ["Statutory and documentation costs (stamp duty, notarisation, courier)", "At actuals"],
  ];
  for (const [label, value, strong] of lines) {
    w.need(18);
    if (strong) {
      w.page.drawRectangle({ x: M - 4, y: w.y - 5, width: right - M + 8, height: 17, color: WASH });
    }
    const f = strong ? bold : font;
    const size = strong ? 10 : 9;
    const labelWidth = right - M - 110;
    const startY = w.y;
    w.para(label, M, labelWidth, size, f, INK, 3);
    const endY = w.y;
    w.y = startY;
    w.text(value, right - f.widthOfTextAtSize(ascii(value), size), size, f, strong ? ACCENT : INK);
    w.y = endY - 5;
  }
  w.para(
    `Total Claimable Wealth in words: ${rupeesInWords(e.totalClaimablePaise)}.`,
    M,
    right - M,
    8.5,
    bold,
    INK,
  );
  if (!e.complete)
    w.para(
      `${r.totals.unvaluedLines} holding${r.totals.unvaluedLines > 1 ? "s have" : " has"} no price available, so the figures above understate the total.`,
      M,
      right - M,
      8.5,
      font,
      MUTED,
    );

  // ── Holdings table
  w.heading("Holdings");
  const cols: [string, number][] = [
    ["Company", M],
    ["Bought", 238],
    ["Original", 282],
    ["Today", 336],
    ["Price / share", 392],
    ["Est. value", 470],
  ];
  w.need(20);
  for (const [h, x] of cols) w.text(h, x, 8, bold, MUTED);
  w.y -= 6;
  w.rule();
  w.y -= 12;
  for (const row of r.rows) {
    w.need(14);
    const name = `${row.name} (${row.symbol})`;
    let shown = ascii(name);
    while (font.widthOfTextAtSize(`${shown}...`, 8.5) > 180 && shown.length > 4)
      shown = shown.slice(0, -2);
    const cells = [
      shown === ascii(name) ? shown : `${shown.trimEnd()}...`,
      String(row.purchaseYear),
      count(row.originalShares),
      row.currentSharesRange.min === row.currentSharesRange.max
        ? count(row.currentShares)
        : `${count(row.currentSharesRange.min)}-${count(row.currentShares)}`,
      row.pricePerShare === null
        ? "n/a"
        : `Rs. ${row.pricePerShare.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`,
      rs(row.marketValuePaise),
    ];
    cells.forEach((c, i) => w.text(c, cols[i]![1], 8.5));
    w.y -= 12;
    for (const so of row.spinOffs) {
      w.need(12);
      w.text(
        `+ ${so.name} (${so.symbol}), from the ${so.recordDate.slice(0, 4)} demerger`,
        M + 10,
        8,
        font,
        MUTED,
      );
      w.text(count(so.shares), 336, 8, font, MUTED);
      w.text(
        so.pricePerShare === null
          ? "n/a"
          : `Rs. ${so.pricePerShare.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`,
        392,
        8,
        font,
        MUTED,
      );
      w.text(rs(so.marketValuePaise), 470, 8, font, MUTED);
      w.y -= 11;
    }
  }
  w.rule();
  w.y -= 14;
  w.text("Total estimated market value", M, 10, bold);
  w.text(rs(r.totals.totalPaise), 470, 10, bold, ACCENT);
  w.y -= 6;

  // ── Corporate action breakdown, per holding
  w.heading("Corporate action breakdown");
  r.rows.forEach((row, i) => {
    w.need(40);
    w.text(`${row.name} (${row.exchange}: ${row.symbol})`, M, 10, bold);
    w.y -= 13;
    w.para(
      `${count(row.originalShares)} shares from ${row.purchaseYear}. ${r.priceNotes[i] ?? ""}`,
      M,
      right - M,
      8.5,
      font,
      MUTED,
    );
    if (row.timeline.length === 0)
      w.para(
        "No bonus, split or demerger on record since the purchase.",
        M + 10,
        right - M - 10,
        8.5,
      );
    for (const t of row.timeline) {
      const change =
        t.kind === "DEMERGER"
          ? t.receivedShares
            ? `${count(t.sharesBefore)} held -> ${count(t.receivedShares)} ${t.receivedSymbol} shares received`
            : `${count(t.sharesBefore)} held -> not valued (checked by your analyst)`
          : `${count(t.sharesBefore)} -> ${count(t.sharesAfter)} shares`;
      w.para(`${t.date}  ${t.label}: ${change}`, M + 10, right - M - 10, 8.5);
    }
    w.para(
      `Dividends declared while held: ${rs(row.dividendPaise)} (${rs(row.dividendsWithCompanyPaise)} last 7 years, ${rs(row.dividendsWithIepfPaise)} older).`,
      M + 10,
      right - M - 10,
      8.5,
      font,
      MUTED,
    );
    for (const a of row.assumptions) w.para(`Note: ${a}`, M + 10, right - M - 10, 8, font, MUTED);
    w.y -= 8;
  });

  // ── Checklist and next steps
  w.heading("Documents the recovery needs");
  for (const group of DOSSIER_CHECKLIST) {
    w.need(30);
    w.text(group.heading, M, 9.5, bold);
    w.y -= 13;
    for (const item of group.items) w.para(`[  ]  ${item}`, M + 8, right - M - 8, 8.5);
    w.y -= 4;
  }
  w.heading("Next steps with Finsol Enterprises");
  DOSSIER_NEXT_STEPS.forEach((s, i) => w.para(`${i + 1}.  ${s}`, M, right - M, 9));
  w.y -= 4;
  w.para(
    `Claims & Case Desk: ${BRAND_EMAILS.claims}   ·   Client Support: ${BRAND_EMAILS.support}`,
    M,
    right - M,
    9,
    bold,
    ACCENT,
  );

  w.heading("Assumptions");
  for (const line of [
    ...VALUATION_ASSUMPTIONS,
    "Pricing is custom to each case and quoted in your engagement letter before anything is signed. Nothing is payable upfront.",
    "Not a registered valuer's certificate. The entitlement is confirmed during verification.",
  ])
    w.para(`-  ${line}`, M, right - M, 8, font, MUTED);
  return Buffer.from(await doc.save());
}
