import { createHash } from "node:crypto";

import {
  computeEntitlement,
  normalizeRelative,
  parseAmount,
  statusOf,
  type IssueCode,
  parseIndianState,
  splitName,
  stateFromPincode,
  STATE_NOT_STATED,
  type FolioState,
  type CorporateActionLike,
  type IngestionForm,
} from "@finsol/shared";

import { blindIndex, encryptField, type FieldKeys } from "./crypto.js";
import { folioColumns, folioSearchColumns } from "./columns.js";
import { bulkUpsertFolios, type StagedFolio } from "./bulk-copy.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { PARSER_VERSION, readStatement, type RawTable } from "./statement-reader.js";

export {
  PARSER_VERSION,
  readStatement,
  formatOf,
  type RawTable,
  type StatementFormat,
} from "./statement-reader.js";

/**
 * IEPF-2 / IEPF-4 statement ingestion, shared by the CLI
 * (`npm run ingest:iepf`) and the admin importer in the API.
 *
 * Column names follow the MCA statutory layout, matched after stripping case,
 * spaces and punctuation, with the variants companies actually publish.
 */
export type Field =
  | "first"
  | "middle"
  | "last"
  | "fullName"
  | "fatherFirst"
  | "fatherMiddle"
  | "fatherLast"
  | "fatherFull"
  | "address"
  | "country"
  | "state"
  | "city"
  | "pincode"
  | "folio"
  | "dematId"
  | "certificates"
  | "amount"
  | "shares"
  | "eventDate"
  | "companyName"
  | "cin"
  | "isin"
  | "srn"
  | "investmentType"
  | "financialYear";

export const HEADER_ALIASES: Record<Field, string[]> = {
  first: [
    "Investor First Name",
    "First Name",
    "Shareholder First Name",
    "Name of Investor First Name",
  ],
  middle: ["Investor Middle Name", "Middle Name", "Shareholder Middle Name"],
  last: ["Investor Last Name", "Last Name", "Shareholder Last Name", "Surname"],
  fullName: [
    "Investor Name",
    "Name of Investor",
    "Name of the Investor",
    "Shareholder Name",
    "Name of the Shareholder",
    "Name of Shareholder",
    "Name",
    // Registrar export code (e.g. HPCL): first holder's name.
    "NAM1",
  ],
  fatherFirst: ["Father/Husband First Name", "Father First Name"],
  fatherMiddle: ["Father/Husband Middle Name", "Father Middle Name"],
  fatherLast: ["Father/Husband Last Name", "Father Last Name"],
  fatherFull: [
    "Father/Husband Name",
    "Father or Spouse Name",
    "Father's Name",
    "Father/Husband's Name",
  ],
  // ADD1: first address line of a registrar export (ADD2/ADD3 follow it).
  address: ["Address", "Investor Address", "Address of Investor", "ADD1"],
  country: ["Country"],
  state: ["State", "State Name"],
  city: ["District", "City", "Town", "Location"],
  pincode: ["Pin Code", "PIN", "Pincode", "Postal Code"],
  folio: [
    "Folio Number",
    "Folio No",
    "Folio",
    "Folio Numbers",
    "Ledger Folio",
    "Folio No.",
    // Registrar export code (e.g. HPCL).
    "FLNO",
  ],
  dematId: [
    "DP Id-Client Id-Account Number",
    "DP Id-Client Id",
    "DPID-Client ID",
    "Client ID",
    "DP Client ID",
    "DPID/Client ID",
  ],
  certificates: [
    "Certificate Numbers",
    "Certificate No",
    "Share Certificate Nos",
    "Certificate Nos",
  ],
  amount: [
    "Amount Transferred",
    "Amount Transfered",
    "Amount Due",
    "Amount Due (in Rs.)",
    "Amount (in Rs.)",
    "Amount in Rs",
    "Amount",
    "Dividend Amount",
    "Unclaimed Amount",
    "Amount to be transferred",
    // Sum of the per-dividend columns in a registrar export (HPCL); a bare "Total" is not an amount.
    "Total Amt",
    "Total Amount",
  ],
  shares: [
    "Number of Shares",
    "Number of underlying Shares",
    "No of underlying Shares",
    "No. of Shares",
    "Shares",
    "Shares Transferred",
    "No of Shares Transferred",
    "Number of Shares to be transferred",
  ],
  eventDate: [
    "Date of Event",
    "Proposed Date of Transfer to IEPF",
    "Proposed Date of transfer to IEPF (DD-MON-YYYY)",
    "Actual Date of Transfer to IEPF",
    "Date of Transfer to IEPF",
    "Date of Transfer",
    "Transfer Date",
  ],
  companyName: ["Company Name", "Name of Company", "Name of the Company"],
  cin: ["CIN", "Company CIN", "Corporate Identification Number"],
  isin: ["ISIN", "ISIN No", "ISIN Number", "ISIN Code"],
  srn: ["SRN", "Service Request Number"],
  investmentType: ["Investment Type", "Nature of Amount", "Nature of Investment"],
  financialYear: ["Financial Year", "Dividend Year", "Year"],
};

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const LOOKUP = new Map<string, Field>();
for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) {
  for (const a of aliases) if (!LOOKUP.has(norm(a))) LOOKUP.set(norm(a), field);
}

/** Header cell → field. Unknown headers that still clearly name a field are matched by prefix. */
function fieldOf(header: string): Field | undefined {
  const n = norm(header);
  if (LOOKUP.has(n)) return LOOKUP.get(n);
  if (n.startsWith("folio")) return "folio";
  if (n.includes("dpidclientid")) return "dematId";
  if (
    n.startsWith("proposeddateoftransfer") ||
    n.startsWith("dateofevent") ||
    n.startsWith("actualdateoftransfer")
  )
    return "eventDate";
  if (n.startsWith("amount") || n.startsWith("dividendamount") || n.startsWith("unclaimedamount"))
    return "amount";
  // "Father / Husband Name (First / Middle / Last)", including the "Husbank" misprint.
  if (
    /^(father|husband|husbank|spouse)/.test(n) &&
    !/first|middle|last/.test(n.replace(/firstmiddlelast$/, ""))
  )
    return "fatherFull";
  if (
    n.startsWith("numberofshares") ||
    n.startsWith("noofshares") ||
    n.startsWith("numberofunderlyingshares") ||
    n === "noof" ||
    n === "numberof" ||
    // HPCL: "Sum of Shares due for transfer to IEPF", "Shares to Trsf to IEPF". Not
    // "Shares As on <date>", which is the current holding.
    n.startsWith("sumofsharesdue") ||
    /^sharesto(trsf|transfer)/.test(n)
  )
    return "shares";
  if (n.startsWith("investorfirstname")) return "first";
  if (n.startsWith("investormiddlename")) return "middle";
  if (n.startsWith("investorlastname")) return "last";
  if (
    /(?:(shareholder|investor|holder|member)s?name|name.*(shareholder|investor|holder|member))/.test(
      n,
    ) &&
    !/father|husband|joint|nominee/.test(n)
  )
    return "fullName";
  return undefined;
}

export function mapHeaders(headers: string[]): {
  map: Partial<Record<Field, number>>;
  unmapped: string[];
} {
  const map: Partial<Record<Field, number>> = {};
  const unmapped: string[] = [];
  headers.forEach((h, i) => {
    const f = fieldOf(h);
    if (f && map[f] === undefined) map[f] = i;
    else if (h.trim()) unmapped.push(h.trim());
  });
  return { map, unmapped };
}

/** IEPF-4 statements list shares; IEPF-2 statements list amounts. */
export function detectForm(map: Partial<Record<Field, number>>): IngestionForm {
  return map.shares !== undefined && map.amount === undefined
    ? "IEPF_4"
    : map.shares !== undefined
      ? "IEPF_4"
      : "IEPF_2";
}

export interface ParsedRow {
  row: number;
  first: string;
  middle: string;
  last: string;
  fatherOrSpouse: string | null;
  /** Father/spouse text exactly as the statement printed it. */
  fatherOrSpouseRaw: string | null;
  address: string | null;
  city: string | null;
  state: FolioState;
  pincode: string | null;
  folio: string;
  certificates: string | null;
  amountRupees: number;
  shares: number;
  eventDate: Date | null;
  transferFinancialYear: string | null;
  companyName: string | null;
  cin: string | null;
  isin: string | null;
  srn: string | null;
  investmentType: string | null;
  /** Validation findings; see ISSUE_SEVERITY in @finsol/shared. */
  issues: IssueCode[];
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).replace(/\s+/g, " ").trim();
}

/** One number from a cell; NaN when it is unreadable or holds more than one number. */
function number(v: unknown): number {
  const r = parseAmount(v);
  return r.value === null ? Number.NaN : r.value;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime()))
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  if (typeof v === "number" && v > 20000 && v < 80000)
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000); // Excel serial
  const s = text(v)
    // A header remnant such as "(DD-MON-YYYY)" printed above the first record.
    .replace(/\(\s*dd\s*[-‐]\s*mon\s*[-‐]\s*yyyy\s*\)/gi, "")
    .trim()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\/\s*/g, "/");
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
  m = /^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return new Date(Date.UTC(y, MONTHS[m[2]!.toLowerCase()]! - 1, +m[1]!));
  }
  return null;
}

/** Indian financial year of a date: 23 Oct 2019 → "2019-20". */
export function financialYear(d: Date): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

export type RowResult =
  { ok: true; value: ParsedRow } | { ok: false; row: number; message: string; issues: IssueCode[] };

export function parseRow(
  cells: unknown[],
  map: Partial<Record<Field, number>>,
  rowNumber: number,
  form: IngestionForm,
  /** Extraction notes from the reader, e.g. WRAPPED_NAME. */
  notes: readonly string[] = [],
): RowResult | null {
  const raw = (f: Field) => (map[f] === undefined ? undefined : cells[map[f]!]);
  const get = (f: Field) => text(raw(f));
  if (cells.every((c) => !text(c))) return null;
  // Totals and footnotes at the end of a statement are not holders.
  if (/^(total|grand total|note|\*)/i.test(text(cells.find((c) => text(c)) ?? ""))) return null;

  let first = get("first");
  let middle = get("middle");
  let last = get("last");
  if (!first && get("fullName")) {
    const p = splitName(get("fullName"));
    first = p.first;
    middle = p.middle;
    last = p.last;
  }
  // Some statements put a whole name in the middle or last column.
  if (!first && middle) {
    const [m1, ...mRest] = middle.split(" ");
    first = m1!;
    middle = mRest.join(" ");
  }
  if (!first && last) [first, last] = [last, ""];
  const fail = (message: string, issues: IssueCode[] = ["UNREADABLE"]): RowResult => ({
    ok: false,
    row: rowNumber,
    message,
    issues,
  });
  if (!first) return fail("No investor name.");

  let folio = (get("folio") || get("dematId")).replace(/\s+/g, "");
  folio = folio.replace(/^(?:idandclientid|clientid|foliono\.?)/i, "");
  // Columns shifted one place in the source: the statement has a PIN column
  // but it is empty, and the folio cell starts with a valid PIN, followed by
  // the real folio or alone with the holder's demat account beside it.
  let shiftedPin: string | null = null;
  if (map.pincode !== undefined && !get("pincode").replace(/\D/g, "")) {
    const m = /^([1-9]\d{5})(\D[A-Za-z0-9/-]*)?$/.exec(folio);
    const demat = get("dematId").replace(/\s+/g, "");
    if (m && stateFromPincode(m[1]!) && (m[2] || (demat && demat !== folio))) {
      shiftedPin = m[1]!;
      folio = m[2] ?? demat;
    }
  }
  if (!folio || folio === "-" || /^n\/?a$/i.test(folio))
    return fail("No folio number or demat account.");
  // NSDL (IN + 14) and CDSL (16 digits from a 120/130 DP ID) accounts are 16
  // characters. A shorter one was cut off in the source and could belong to
  // anyone with the same depository participant, so it is never merged on.
  if (/^IN3\d{4,12}$/i.test(folio) || /^1[23]0\d{7,12}$/.test(folio))
    return fail("Demat account number is cut off in the source.", ["FOLIO_INCOMPLETE"]);

  const country = get("country");
  // With no PIN column, a PIN printed at the end of the address is used.
  const pinDigits = shiftedPin
    ? shiftedPin
    : map.pincode !== undefined
      ? get("pincode").replace(/\D/g, "")
      : (/(?:^|\D)([1-9]\d{2}\s?\d{3})\s*$/.exec(get("address"))?.[1] ?? "").replace(/\s/g, "");
  const stateText = get("state");
  // An Indian state as written wins (PDF country cells carry address spill-over,
  // e.g. "DHARMPUR INDIA"); then a clearly foreign country; then the PIN's state;
  // else "not stated".
  const writtenState = parseIndianState(stateText);
  const foreign =
    !!country &&
    !/india$|\bindia\b|^(ind|bharat|na|n\/a|-)$/i.test(country.replace(/[^A-Za-z/ -]/g, "").trim());
  const blankState = !stateText || /^(na|n\/a|-|‐)$/i.test(stateText);
  const state: FolioState | null =
    writtenState && writtenState !== "OUT_OF_INDIA"
      ? writtenState
      : foreign || writtenState === "OUT_OF_INDIA"
        ? "OUT_OF_INDIA"
        : (stateFromPincode(pinDigits) ?? (blankState ? STATE_NOT_STATED : null));
  if (!state) return fail(`Unknown state "${stateText}".`);

  const issues: IssueCode[] = [];
  const amountCell = map.amount === undefined ? null : parseAmount(raw("amount"));
  const rawShares = raw("shares");
  const cleanShares =
    typeof rawShares === "string" ? rawShares.replace(/^shares\s*/i, "").trim() : rawShares;
  const sharesCell = map.shares === undefined ? null : parseAmount(cleanShares);
  if (amountCell?.ambiguous || sharesCell?.ambiguous) issues.push("AMOUNT_AMBIGUOUS");
  let shares = sharesCell ? (sharesCell.value ?? Number.NaN) : 0;
  let amount = amountCell ? (amountCell.value ?? Number.NaN) : 0;
  // IEPF-2 statements list the shares behind unclaimed dividends as their own
  // rows, with the share count in the amount column.
  if (
    map.shares === undefined &&
    /number of (underlying )?shares|^shares$|equity shares/i.test(get("investmentType"))
  ) {
    shares = amount;
    amount = 0;
  }
  if (Number.isNaN(shares) || shares < 0) return fail("Share count is not a number.");
  if (amountCell?.ambiguous || sharesCell?.ambiguous)
    return fail("The amount or share cell holds more than one number.", ["AMOUNT_AMBIGUOUS"]);
  if (Number.isNaN(amount) || amount < 0) return fail("Amount is not a number.");
  if (form === "IEPF_4" && shares <= 0) return fail("IEPF-4 rows need a share count.");
  if (form === "IEPF_2" && amount <= 0 && shares <= 0) return fail("IEPF-2 rows need an amount.");

  const relativeParts = get("fatherFull")
    ? [get("fatherFull")]
    : [get("fatherFirst"), get("fatherMiddle"), get("fatherLast")];
  const fatherRaw = relativeParts.filter(Boolean).join(" | ") || null;
  const relative = normalizeRelative(relativeParts);
  issues.push(...relative.issues);
  if (notes.includes("WRAPPED_NAME")) issues.push("WRAPPED_NAME");
  if (notes.includes("MERGED_FRAGMENT")) issues.push("MERGED_FRAGMENT");
  if (notes.includes("NAME_CONTINUED")) issues.push("NAME_CONTINUED");
  if (shiftedPin) issues.push("PIN_IN_FOLIO");
  if (/\d/.test([first, middle, last].join(""))) issues.push("NAME_SUSPECT");
  if (!get("address")) issues.push("ADDRESS_MISSING");
  if (pinDigits.length !== 6) issues.push("PIN_MISSING");
  if (state === STATE_NOT_STATED) issues.push("STATE_NOT_STATED");
  else if (!writtenState && !foreign && stateFromPincode(pinDigits)) issues.push("STATE_FROM_PIN");
  let eventDate = parseDate(raw("eventDate"));
  // A PDF date that lost its day to the amount cell ("750.00 02" | "-DEC-2017").
  if (!eventDate && map.amount !== undefined) {
    const day = /\b(\d{1,2})\s*$/.exec(text(raw("amount")).replace(/\d[\d,]*\.\d{1,2}/g, ""))?.[1];
    if (day) eventDate = parseDate(`${day}${text(raw("eventDate"))}`);
  }
  if (!eventDate) issues.push("EVENT_DATE_MISSING");
  const pin = pinDigits;
  const fy = get("financialYear");
  return {
    ok: true,
    value: {
      row: rowNumber,
      first,
      middle,
      last,
      fatherOrSpouse: relative.value,
      fatherOrSpouseRaw: fatherRaw,
      address: get("address") || null,
      city: get("city") || null,
      state,
      pincode: pin.length === 6 ? pin : null,
      folio,
      certificates: get("certificates") || null,
      amountRupees: Math.round(amount * 100) / 100,
      shares: Math.floor(shares),
      eventDate,
      transferFinancialYear: eventDate
        ? financialYear(eventDate)
        : /^\d{4}-\d{2,4}$/.test(fy)
          ? fy
          : null,
      companyName: get("companyName") || null,
      cin: get("cin").toUpperCase() || null,
      isin: get("isin").toUpperCase() || null,
      srn: get("srn") || null,
      investmentType: get("investmentType") || null,
      issues: [...new Set(issues)],
    },
  };
}

/** A blank CSV with the MCA statutory columns, for the admin page. */
export const TEMPLATE_HEADERS = [
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
  "Amount Transferred",
  "Number of Shares",
  "Proposed Date of Transfer to IEPF",
];

export interface SourceInfo {
  url?: string | null;
  retrievedAt: Date;
  publishedAt?: Date | null;
  publishedAtBasis?: "HTTP_LAST_MODIFIED" | "STATED_IN_DOCUMENT" | "UNKNOWN";
  reportingPeriod?: string | null;
  documentType?: "IEPF_2_STATEMENT" | "IEPF_4_STATEMENT" | "AUTHORISED_UPLOAD" | "LICENSED_FEED";
}

export interface IngestOptions {
  /** The statement's company. Rows may instead name it by CIN or company name. */
  companyId?: string | null;
  /** IEPF-2 or IEPF-4. Detected from the columns when omitted. */
  form?: IngestionForm;
  /** ingestion_jobs.id to stamp on rows. */
  jobId?: string | null;
  /** Connection for the bulk COPY; defaults to DATABASE_URL. */
  databaseUrl?: string;
  /** Parse, validate and report without writing anything. */
  dryRun?: boolean;
  /** With dryRun: also return the holder records that would be written (in memory only). */
  plan?: boolean;
  /** Where the file came from. When given, a source document and its rows are recorded. */
  source?: SourceInfo;
  /**
   * What a share list's quantities mean. Required for share lists imported
   * with `source`: a list due for transfer is never recorded as transferred.
   */
  shareBasis?: "PROPOSED_IEPF_TRANSFER" | "TRANSFERRED_TO_IEPF";
  /** Called with progress counts every batch. */
  onProgress?: (done: number, total: number) => void;
}

export interface IngestResult {
  form: IngestionForm;
  sheet: string;
  parserVersion: string;
  sha256: string;
  sourceDocumentId: string | null;
  totalRows: number;
  insertedRows: number;
  updatedRows: number;
  /** Rows not merged into holder records (quarantined, kept in source_rows when recorded). */
  skippedRows: number;
  /** Holder records written but held back from search until reviewed. */
  quarantinedRecords: number;
  validRows: number;
  warningRows: number;
  quarantinedRows: number;
  /** Count of each issue code across rows. */
  issueCounts: Partial<Record<IssueCode, number>>;
  /** Time spent streaming rows in (binary COPY) and merging them, when written. */
  timings?: { copyMs: number; mergeMs: number };
  errors: { row: number; message: string }[];
  unmappedHeaders: string[];
  /** First few parsed rows (dry runs only, folio and address withheld), for checking a layout. */
  preview: Omit<ParsedRow, "folio" | "address" | "fatherOrSpouseRaw">[];
  /** With dryRun + plan: the records that would be written. Holds personal data; never print it. */
  planned?: StagedFolio[];
  /** Dividend events and share snapshots written (imports with `source` only). */
  dividendEvents?: { written: number; amountTotal: number };
  shareSnapshots?: number;
  /** Sum of amounts and shares across accepted rows, for reconciliation with statement totals. */
  totals?: { amount: number; shares: number };
}

const MAX_ERRORS_KEPT = 50;

const SEVERITY_RANK = { VALID: 0, WARNING: 1, QUARANTINED: 2 } as const;

/**
 * Parses a statement, validates every row, and upserts its holders.
 * - Rows for the same company, folio and holder are grouped (IEPF-2 lists
 *   one row per unpaid dividend).
 * - With `source`, the file is recorded in source_documents (by checksum and
 *   parser version) and every row in source_rows: its raw cells encrypted
 *   and immutable, its row reference, issues and validation status. Re-running
 *   the same file with the same reader changes nothing new (idempotent).
 * - Quarantined rows never disappear: they stay in source_rows (and the
 *   import report), and any holder record they would create is written with
 *   review_status QUARANTINED, out of search until staff review it.
 * - Post-action shares apply every bonus and split dated after the row's
 *   event date, since the IEPF keeps receiving them.
 */
export async function ingestStatement(
  db: PrismaClient,
  keys: FieldKeys,
  file: { buffer: Buffer; fileName: string; contentType?: string | null },
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  const table: RawTable = await readStatement(file.buffer, file.fileName, file.contentType);
  const { map, unmapped } = mapHeaders(table.headers);
  if (map.first === undefined && map.fullName === undefined && map.last === undefined) {
    throw new Error(
      `No investor name column. Headers found: ${table.headers.filter(Boolean).join(", ")}`,
    );
  }
  const form = opts.form ?? detectForm(map);
  if (form === "IEPF_4" && opts.source && !opts.shareBasis)
    throw new Error(
      "This is a share list, but whether its shares were transferred or are only due for transfer is not known. Classify the document before importing.",
    );

  const companies = await db.company.findMany({
    select: { id: true, cin: true, slug: true, name: true, isin: true, legacyIsins: true },
  });
  const bySlugOrName = new Map<string, string>();
  for (const c of companies) {
    bySlugOrName.set(norm(c.name), c.id);
    bySlugOrName.set(norm(c.name.replace(/limited$/i, "ltd")), c.id);
  }
  const byCin = new Map(companies.filter((c) => c.cin).map((c) => [c.cin!, c.id]));
  // Old statements print the ISIN of the day, including pre-split ones.
  const byIsin = new Map(
    companies.flatMap((c) => [...(c.isin ? [c.isin] : []), ...c.legacyIsins].map((i) => [i, c.id])),
  );
  const actionsFor = new Map<string, CorporateActionLike[]>();
  async function actions(companyId: string) {
    if (!actionsFor.has(companyId)) {
      const rows = await db.corporateAction.findMany({ where: { companyId } });
      actionsFor.set(
        companyId,
        rows.map((a) => ({
          actionType: a.actionType,
          exDate: a.exDate.toISOString().slice(0, 10),
          ratioFrom: a.ratioFrom === null ? null : Number(a.ratioFrom),
          ratioTo: a.ratioTo === null ? null : Number(a.ratioTo),
          dividendPerShare: a.dividendPerShare === null ? null : Number(a.dividendPerShare),
        })),
      );
    }
    return actionsFor.get(companyId)!;
  }

  const errors: { row: number; message: string }[] = [];
  const keep = (e: { row: number; message: string }) => {
    if (errors.length < MAX_ERRORS_KEPT) errors.push(e);
  };
  interface Group {
    companyId: string;
    row: ParsedRow;
    amounts: Record<string, number>;
    shares: number;
    issues: Set<IssueCode>;
    rowIndexes: number[];
  }
  const groups = new Map<string, Group>();
  /** Per table row: what happened to it, for source_rows. */
  const outcomes: {
    index: number;
    issues: IssueCode[];
    status: "VALID" | "WARNING" | "QUARANTINED";
    groupKey: string | null;
  }[] = [];
  const issueCounts: Partial<Record<IssueCode, number>> = {};
  /** Accepted lines, for dividend events and share snapshots. */
  const accepted: { index: number; companyId: string; row: ParsedRow; folioHash: string }[] = [];
  const count = (issues: readonly IssueCode[]) => {
    for (const i of issues) issueCounts[i] = (issueCounts[i] ?? 0) + 1;
  };
  const eventKey = (r: ParsedRow) =>
    r.eventDate ? r.eventDate.toISOString().slice(0, 10) : (r.transferFinancialYear ?? "undated");
  let total = 0;
  let skipped = 0;
  table.rows.forEach((cells, i) => {
    const res = parseRow(cells, map, table.firstDataRow + i, form, table.rowNotes?.[i] ?? []);
    if (!res) return;
    total++;
    if (!res.ok) {
      skipped++;
      count(res.issues);
      keep({ row: res.row, message: res.message });
      outcomes.push({ index: i, issues: res.issues, status: "QUARANTINED", groupKey: null });
      return;
    }
    const r = res.value;
    const companyId =
      opts.companyId ??
      (r.cin && byCin.get(r.cin)) ??
      (r.isin && byIsin.get(r.isin)) ??
      (r.companyName && bySlugOrName.get(norm(r.companyName))) ??
      null;
    if (!companyId) {
      skipped++;
      count(["UNREADABLE"]);
      keep({
        row: r.row,
        message: `Unknown company ${r.cin ?? r.isin ?? r.companyName ?? ""}`.trim(),
      });
      outcomes.push({ index: i, issues: ["UNREADABLE"], status: "QUARANTINED", groupKey: null });
      return;
    }
    count(r.issues);
    const folioHash = blindIndex(r.folio, keys);
    accepted.push({ index: i, companyId, row: r, folioHash });
    const key = `${companyId}|${folioHash}|${[r.first, r.middle, r.last].join(" ").toUpperCase()}`;
    outcomes.push({ index: i, issues: r.issues, status: statusOf(r.issues), groupKey: key });
    const g = groups.get(key);
    if (g) {
      if (r.amountRupees)
        g.amounts[eventKey(r)] =
          Math.round(((g.amounts[eventKey(r)] ?? 0) + r.amountRupees) * 100) / 100;
      g.shares = Math.max(g.shares, r.shares);
      for (const issue of r.issues) g.issues.add(issue);
      g.rowIndexes.push(i);
      if (r.eventDate && (!g.row.eventDate || r.eventDate > g.row.eventDate)) {
        g.row.eventDate = r.eventDate;
        g.row.transferFinancialYear = r.transferFinancialYear;
      }
      // Two lines of one holder that disagree on the relative: keep the clean one, flag it.
      if (g.row.fatherOrSpouse !== r.fatherOrSpouse && !r.issues.includes("RELATIVE_SUSPECT"))
        if (g.issues.has("RELATIVE_SUSPECT") || !g.row.fatherOrSpouse) {
          g.row.fatherOrSpouse = r.fatherOrSpouse;
          g.row.fatherOrSpouseRaw = r.fatherOrSpouseRaw;
        }
    } else
      groups.set(key, {
        companyId,
        row: r,
        amounts: r.amountRupees ? { [eventKey(r)]: r.amountRupees } : {},
        shares: r.shares,
        issues: new Set(r.issues),
        rowIndexes: [i],
      });
  });

  const tally = { VALID: 0, WARNING: 0, QUARANTINED: 0 };
  for (const o of outcomes) tally[o.status]++;
  const list = [...groups.values()];
  const result: IngestResult = {
    form,
    sheet: table.sheet,
    parserVersion: PARSER_VERSION,
    sha256,
    sourceDocumentId: null,
    totalRows: total,
    insertedRows: 0,
    updatedRows: 0,
    skippedRows: skipped,
    quarantinedRecords: list.filter((g) => statusOf([...g.issues]) === "QUARANTINED").length,
    validRows: tally.VALID,
    warningRows: tally.WARNING,
    quarantinedRows: tally.QUARANTINED,
    issueCounts,
    errors,
    unmappedHeaders: unmapped,
    preview: [],
  };
  if (opts.dryRun && !opts.plan) {
    result.preview = list.slice(0, 5).map(({ row }) => {
      const { folio: _folio, address: _address, fatherOrSpouseRaw: _raw, ...rest } = row;
      return rest;
    });
    return result;
  }

  // Provenance: the document (once per checksum and reader) and every row.
  let sourceDocumentId: string | null = null;
  const rowIds = new Map<number, string>();
  if (opts.source && !opts.dryRun) {
    const companyIds = new Set(list.map((g) => g.companyId));
    const doc = await db.sourceDocument.upsert({
      where: { sha256_parserVersion: { sha256, parserVersion: PARSER_VERSION } },
      update: {
        status: "PARSED",
        rowCount: total,
        validRows: tally.VALID,
        warningRows: tally.WARNING,
        quarantinedRows: tally.QUARANTINED,
        ingestionJobId: opts.jobId ?? undefined,
      },
      create: {
        companyId: opts.companyId ?? (companyIds.size === 1 ? [...companyIds][0]! : null),
        sourceUrl: opts.source.url ?? null,
        fileName: file.fileName,
        documentType:
          opts.source.documentType ?? (form === "IEPF_4" ? "IEPF_4_STATEMENT" : "IEPF_2_STATEMENT"),
        reportingPeriod: opts.source.reportingPeriod ?? null,
        publishedAt: opts.source.publishedAt ?? null,
        publishedAtBasis: opts.source.publishedAtBasis ?? "UNKNOWN",
        retrievedAt: opts.source.retrievedAt,
        sha256,
        bytes: file.buffer.length,
        contentType: file.contentType ?? null,
        parserVersion: PARSER_VERSION,
        status: "PARSED",
        quantityBasis: form === "IEPF_4" ? "SHARES_AS_STATED_ON_EVENT_DATE" : "AMOUNT_ONLY",
        rowCount: total,
        validRows: tally.VALID,
        warningRows: tally.WARNING,
        quarantinedRows: tally.QUARANTINED,
        ingestionJobId: opts.jobId ?? null,
      },
    });
    sourceDocumentId = doc.id;
    result.sourceDocumentId = doc.id;
    const existing = await db.sourceRow.findMany({
      where: { sourceDocumentId: doc.id },
      select: { id: true, rowIndex: true },
    });
    for (const e of existing) rowIds.set(e.rowIndex, e.id);
    const fresh = outcomes.filter((o) => !rowIds.has(o.index));
    for (let k = 0; k < fresh.length; k += 1000) {
      const batch = fresh.slice(k, k + 1000).map((o) => {
        const id = crypto.randomUUID();
        rowIds.set(o.index, id);
        const cells = Object.fromEntries(
          table.headers.map((h, c) => [h || `column ${c + 1}`, table.rows[o.index]![c] ?? null]),
        );
        const json = JSON.stringify(cells);
        return {
          id,
          sourceDocumentId: doc.id,
          rowIndex: o.index,
          rowRef: table.rowRefs?.[o.index] ?? `${table.sheet}, row ${table.firstDataRow + o.index}`,
          rawCellsEnc: encryptField(json, keys),
          rawHash: blindIndex(json, keys),
          extractionNotes: table.rowNotes?.[o.index] ?? [],
          validationStatus: o.status,
          issues: o.issues,
          reviewStatus: o.status === "QUARANTINED" ? "PENDING_REVIEW" : "NOT_REQUIRED",
        };
      });
      await db.sourceRow.createMany({ data: batch, skipDuplicates: true });
    }
  }

  // Post-action shares: the IEPF keeps receiving bonuses and splits after the transfer.
  const staged: StagedFolio[] = [];
  for (const g of list) {
    const r = g.row;
    const after = r.eventDate ? r.eventDate.toISOString().slice(0, 10) : null;
    const computed =
      g.shares > 0 && after
        ? computeEntitlement(g.shares, await actions(g.companyId), { acquiredOn: after }).shares
        : g.shares;
    // Actions dated on the transfer day itself are already reflected in the statement's count.
    const post = after ? Math.max(g.shares, computed) : computed;
    const issues = [...g.issues];
    const status = statusOf(issues);
    staged.push({
      companyId: g.companyId,
      investorFirstName: r.first,
      investorMiddleName: r.middle || null,
      investorLastName: r.last || null,
      investorFullName: [r.first, r.middle, r.last].filter(Boolean).join(" "),
      fatherOrSpouseName: r.fatherOrSpouse,
      fatherOrSpouseRaw: r.fatherOrSpouseRaw,
      addressLine: r.address,
      city: r.city,
      state: r.state,
      pincode: r.pincode,
      ...folioColumns(r.folio, keys),
      certificateNumbers: r.certificates,
      originalShares: g.shares,
      postActionShares: post,
      amountsByEvent: g.amounts,
      custodyStatus:
        form === "IEPF_4"
          ? opts.shareBasis === "PROPOSED_IEPF_TRANSFER"
            ? "DUE_FOR_IEPF_TRANSFER"
            : "IEPF_AUTHORITY"
          : g.shares > 0
            ? "COMPANY_SUSPENSE"
            : "PHYSICAL_DORMANT",
      eventDate: r.eventDate,
      transferFinancialYear: r.transferFinancialYear,
      investmentType: r.investmentType,
      sourceFilingSrn: r.srn,
      ingestionJobId: opts.jobId ?? null,
      validationStatus: status,
      validationIssues: issues,
      reviewStatus: status === "QUARANTINED" ? "QUARANTINED" : "PUBLISHED",
      sourceDocumentId,
      sourceRowIds: g.rowIndexes.map((i) => rowIds.get(i)).filter((x): x is string => !!x),
      quantityBasis: g.shares > 0 ? "SHARES_AS_STATED_ON_EVENT_DATE" : "AMOUNT_ONLY",
      quantityEffectiveDate: g.shares > 0 ? r.eventDate : null,
      ...folioSearchColumns({ first: r.first, middle: r.middle, last: r.last }),
    });
  }
  if (opts.dryRun) {
    result.planned = staged;
    return result;
  }
  const bulk = await bulkUpsertFolios(staged, { form, databaseUrl: opts.databaseUrl });
  result.insertedRows = bulk.inserted;
  result.updatedRows = bulk.updated;
  result.timings = { copyMs: bulk.copyMs, mergeMs: bulk.mergeMs };
  if (sourceDocumentId) {
    await db.sourceDocument.update({
      where: { id: sourceDocumentId },
      data: { status: "IMPORTED", statusDetail: null },
    });
    // Link each source row to the holder record it fed (folio ids exist only after the merge).
    // Unnesting the row ids makes this a hash join on the row key; `r.id = ANY(f.source_row_ids)`
    // compared every row with every record (minutes for a 7,000-row statement).
    await db.$executeRaw`
      UPDATE source_rows r SET folio_id = x.id, folio_state = x.state
      FROM (SELECT f.id, f.state, unnest(f.source_row_ids) AS row_id
              FROM unclaimed_folios f
             WHERE f.source_document_id = ${sourceDocumentId}::uuid) x
      WHERE r.id = x.row_id
        AND r.source_document_id = ${sourceDocumentId}::uuid
        AND r.folio_id IS NULL`;
  }
  const totals = accepted.reduce(
    (t, a) => ({ amount: t.amount + a.row.amountRupees, shares: t.shares + a.row.shares }),
    { amount: 0, shares: 0 },
  );
  result.totals = { amount: Math.round(totals.amount * 100) / 100, shares: totals.shares };
  if (sourceDocumentId) {
    const ev = await writeDividendEvents(db, sourceDocumentId, accepted, rowIds, eventKey);
    result.dividendEvents = ev;
    if (opts.shareBasis)
      result.shareSnapshots = await writeShareSnapshots(
        db,
        sourceDocumentId,
        accepted,
        rowIds,
        opts.shareBasis,
      );
  }
  opts.onProgress?.(list.length, list.length);
  return result;
}

export type Accepted = { index: number; companyId: string; row: ParsedRow; folioHash: string };
export const holderNorm = (r: ParsedRow) =>
  [r.first, r.middle, r.last].filter(Boolean).join(" ").toUpperCase();

/**
 * One row per declared dividend per holder line. A republication of the same
 * event (same holder, date and amount) adds its source instead of a new row;
 * different dates or years stay separate.
 */
export async function writeDividendEvents(
  db: PrismaClient,
  documentId: string,
  accepted: Accepted[],
  rowIds: Map<number, string>,
  eventKey: (r: ParsedRow) => string,
): Promise<{ written: number; amountTotal: number }> {
  const rows = accepted.filter((a) => a.row.amountRupees > 0);
  let written = 0;
  for (let k = 0; k < rows.length; k += 2000) {
    const chunk = rows.slice(k, k + 2000);
    written += await db.$executeRaw`
      INSERT INTO holder_dividend_events
        (company_id, folio_number_hash, holder_name_norm, event_key, amount, investment_type,
         source_document_ids, source_row_ids)
      SELECT c::uuid, h, n, e, a::numeric, max(t), ARRAY[${documentId}::uuid],
             COALESCE(ARRAY_AGG(r::uuid) FILTER (WHERE r IS NOT NULL), '{}'::uuid[])
        FROM unnest(${chunk.map((a) => a.companyId)}::text[], ${chunk.map((a) => a.folioHash)}::text[],
                    ${chunk.map((a) => holderNorm(a.row))}::text[], ${chunk.map((a) => eventKey(a.row))}::text[],
                    ${chunk.map((a) => a.row.amountRupees.toFixed(2))}::text[],
                    ${chunk.map((a) => a.row.investmentType)}::text[],
                    ${chunk.map((a) => rowIds.get(a.index) ?? null)}::text[]) AS x(c, h, n, e, a, t, r)
       GROUP BY c, h, n, e, a
      ON CONFLICT (company_id, folio_number_hash, holder_name_norm, event_key, amount) DO UPDATE SET
        source_document_ids = ARRAY(SELECT DISTINCT unnest(holder_dividend_events.source_document_ids || EXCLUDED.source_document_ids)),
        source_row_ids = ARRAY(SELECT DISTINCT unnest(holder_dividend_events.source_row_ids || EXCLUDED.source_row_ids)),
        last_seen_at = now()`;
  }
  return {
    written,
    amountTotal: Math.round(rows.reduce((t, a) => t + a.row.amountRupees, 0) * 100) / 100,
  };
}

/** A share quantity exactly as this statement reports it, with what it means. */
export async function writeShareSnapshots(
  db: PrismaClient,
  documentId: string,
  accepted: Accepted[],
  rowIds: Map<number, string>,
  basis: "PROPOSED_IEPF_TRANSFER" | "TRANSFERRED_TO_IEPF",
): Promise<number> {
  const rows = accepted.filter((a) => a.row.shares > 0);
  let written = 0;
  for (let k = 0; k < rows.length; k += 2000) {
    const chunk = rows.slice(k, k + 2000);
    written += await db.$executeRaw`
      INSERT INTO shareholding_snapshots
        (company_id, folio_number_hash, holder_name_norm, shares, basis, as_of, source_document_id, source_row_id)
      SELECT c::uuid, h, n, s::int, ${basis}, d::date, ${documentId}::uuid, r::uuid
        FROM unnest(${chunk.map((a) => a.companyId)}::text[], ${chunk.map((a) => a.folioHash)}::text[],
                    ${chunk.map((a) => holderNorm(a.row))}::text[], ${chunk.map((a) => String(a.row.shares))}::text[],
                    ${chunk.map((a) => a.row.eventDate?.toISOString().slice(0, 10) ?? null)}::text[],
                    ${chunk.map((a) => rowIds.get(a.index) ?? null)}::text[]) AS x(c, h, n, s, d, r)
      ON CONFLICT (company_id, folio_number_hash, holder_name_norm, basis, source_document_id) DO NOTHING`;
  }
  return written;
}
