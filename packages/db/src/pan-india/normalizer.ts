import { createHash } from "node:crypto";
import {
  isIndianState,
  parseIndianState,
  stateFromPincode,
  normalizeName,
  splitName,
  phoneticKeys,
  normalizeRelative,
  parseAmount,
  statusOf,
  STATE_NOT_STATED,
  type FolioState,
  type IndianState,
  type IssueCode,
} from "@finsol/shared";

import { blindIndex, encryptField, type FieldKeys } from "../crypto.js";
import type { NormalizedFolioRecord, RawInputRow } from "./types.js";

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Matchers for varying RTA and MCA spreadsheet headers */
const COLUMN_ALIASES = {
  firstName: [
    "investorfirstname",
    "firstname",
    "investorname",
    "shareholdername",
    "nameoftheshareholders",
    "nameoftheshareholder",
    "nameoffirstholder",
    "firstholdername",
    "membername",
    "holdername",
    "fullname",
    "name",
  ],
  middleName: ["investormiddlename", "middlename"],
  lastName: ["investorlastname", "lastname", "surname"],
  fullName: [
    "investorfullname",
    "nameoftheshareholders",
    "nameoftheshareholder",
    "shareholdername",
    "investorname",
    "name",
    "fullname",
  ],
  fatherName: [
    "fathername",
    "fatherhusbandname",
    "fatherhusbandfirstname",
    "fatherorspousename",
    "relativename",
    "guardianname",
    "husbandname",
    "fathersname",
  ],
  fatherMiddle: ["fatherhusbandmiddlename", "fathermiddlename"],
  fatherLast: ["fatherhusbandlastname", "fatherlastname"],
  folio: [
    "folionumber",
    "foliono",
    "folio",
    "dpidclientid",
    "dpidclientidaccountnumber",
    "folionodpidclientid",
    "folionumberdpid",
    "foliodpidclientid",
    "ledgerfoliono",
    "clientid",
    "folioclid",
    "accountno",
  ],
  amount: [
    "amounttransferred",
    "unclaimedamount",
    "dividendamount",
    "amountforunclaimedandunpaiddividend",
    "unpaiddividendamount",
    "unclaimeddividend",
    "amount",
    "netamount",
    "amountrs",
    "amountinr",
    "unclaimeddividendamount",
  ],
  eventDate: [
    "proposeddateoftransfer",
    "proposeddateoftransfertoiepf",
    "actualdateoftransfertoiepf",
    "dateoftransfer",
    "dateoftransfertoiepf",
    "dateofevent",
    "transferdate",
    "duedateoftransfer",
    "eventdate",
  ],
  shares: [
    "numberofshares",
    "noofshares",
    "sharestransferred",
    "shares",
    "noof",
    "numberofunderlyingshares",
    "noofunderlyingshares",
    "sharescreditedtoiepf",
  ],
  state: ["state", "investorstate", "statename", "investorstatename"],
  city: ["city", "district", "town", "investordistrict"],
  address: ["address", "investoraddress", "addressline1", "addressline"],
  pincode: ["pincode", "pin", "pincode", "postalcode", "zip", "investorpincode"],
  country: ["country", "investorcountry"],
  financialYear: ["financialyear", "fy", "year"],
};

export class HeaderMapper {
  private readonly mapping: Map<string, string> = new Map();

  constructor(headers: string[]) {
    for (const h of headers) {
      const n = norm(h);
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (!this.mapping.has(field) && aliases.some((a) => n === a || n.startsWith(a))) {
          this.mapping.set(field, h);
          break;
        }
      }
    }
  }

  get(field: string): string | undefined {
    return this.mapping.get(field);
  }

  has(field: string): boolean {
    return this.mapping.has(field);
  }
}

/** Pre-computes teaser representation (e.g. RIL***21) */
export function maskFolio(folio: string): string {
  const clean = folio.replace(/\s+/g, "").toUpperCase();
  if (clean.length <= 4) return `${clean}****`;
  const head = clean.slice(0, 3);
  const tail = clean.slice(-2);
  return `${head}***${tail}`;
}

/** Parses dates in ISO, DD-MON-YYYY, DD/MM/YYYY, or YYYY-MM-DD */
export function parseDateFlexible(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val;
  const str = String(val).trim();
  if (!str || str === "-" || /^na$/i.test(str)) return null;

  const d = new Date(str);
  if (!Number.isNaN(d.getTime())) return d;

  const parts = str.split(/[-/.]/);
  if (parts.length === 3) {
    const day = Number(parts[0]);
    const monthStr = parts[1]!.toLowerCase();
    const year = Number(parts[2]!.length === 2 ? `20${parts[2]}` : parts[2]);

    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const month = months[monthStr.slice(0, 3)] ?? (Number(monthStr) - 1);
    if (!Number.isNaN(day) && month >= 0 && month <= 11 && !Number.isNaN(year)) {
      const parsed = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
}

/** Normalizes a raw input row into a typed database partition record */
export function normalizeFolioRow(
  raw: RawInputRow,
  mapper: HeaderMapper,
  context: {
    companyId: string;
    companyName: string;
    sourceRta: string;
    sourceFileName: string;
    batchRunId: string;
    keys: FieldKeys;
    sourceDocumentId?: string;
  },
): NormalizedFolioRecord | null {
  const getCell = (field: string): string => {
    const colName = mapper.get(field);
    if (!colName) return "";
    return String(raw[colName] ?? "").trim();
  };

  // 1. Investor Name Normalization
  let first = getCell("firstName");
  let middle = getCell("middleName");
  let last = getCell("lastName");
  const fullRaw = getCell("fullName");

  if (!first && fullRaw) {
    const p = splitName(fullRaw);
    first = p.first;
    middle = p.middle;
    last = p.last;
  } else if (first && !middle && !last && first.includes(" ")) {
    const p = splitName(first);
    first = p.first;
    middle = p.middle;
    last = p.last;
  } else if (!first && middle) {
    first = middle;
    middle = "";
  } else if (!first && last) {
    first = last;
    last = "";
  }

  const investorFullName = normalizeName([first, middle, last].filter(Boolean).join(" "));
  if (!investorFullName || investorFullName.length < 2) {
    return null; // Skip non-holder summary/total rows
  }

  // 2. Folio Number Normalization
  let folio = getCell("folio").replace(/\s+/g, "").toUpperCase();
  folio = folio.replace(/^(?:IDANDCLIENTID|CLIENTID|FOLIONO\.?)/i, "");
  if (!folio || folio === "-" || /^N\/?A$/i.test(folio)) {
    return null;
  }

  // 3. Address & State Resolution
  const stateRaw = getCell("state");
  const pinDigits = getCell("pincode").replace(/\D/g, "");
  const country = getCell("country");
  const city = getCell("city");
  const addressLine = getCell("address");

  const writtenState = parseIndianState(stateRaw);
  const isForeign =
    !!country && !/india$|\bindia\b|^(ind|bharat|na|n\/a|-)$/i.test(country.replace(/[^A-Za-z/ -]/g, "").trim());

  let state: FolioState = STATE_NOT_STATED;
  const issues: IssueCode[] = [];

  if (writtenState && writtenState !== "OUT_OF_INDIA") {
    state = writtenState as IndianState;
  } else if (isForeign || writtenState === "OUT_OF_INDIA") {
    state = "OUT_OF_INDIA";
  } else {
    const pinState = stateFromPincode(pinDigits);
    if (pinState) {
      state = pinState as IndianState;
      issues.push("STATE_FROM_PIN");
    } else {
      issues.push("STATE_NOT_STATED");
    }
  }

  if (pinDigits.length !== 6 && state !== "OUT_OF_INDIA") {
    issues.push("PIN_MISSING");
  }

  // 4. Relative / Father Name
  const fatherRaw = [getCell("fatherName"), getCell("fatherMiddle"), getCell("fatherLast")]
    .filter(Boolean)
    .join(" ");
  const relative = normalizeRelative([fatherRaw]);
  issues.push(...relative.issues);

  // 5. Amount & Shares
  const amountParsed = parseAmount(getCell("amount"));
  const sharesParsed = parseAmount(getCell("shares"));
  if (amountParsed.ambiguous || sharesParsed.ambiguous) {
    issues.push("AMOUNT_AMBIGUOUS");
  }

  const unclaimedDividendAmount = Math.max(0, amountParsed.value ?? 0);
  const originalShares = Math.max(0, Math.floor(sharesParsed.value ?? 0));

  // 6. Dates & Custody Status
  const eventDate = parseDateFlexible(getCell("eventDate"));
  if (!eventDate) issues.push("EVENT_DATE_MISSING");

  const fy = getCell("financialYear") || (eventDate ? `FY ${eventDate.getUTCFullYear()}` : null);
  const eventKey = eventDate ? eventDate.toISOString().slice(0, 10) : fy ?? "2026-IEPF";
  const amountsByEvent: Record<string, number> = {};
  if (unclaimedDividendAmount > 0) {
    amountsByEvent[eventKey] = Math.round(unclaimedDividendAmount * 100) / 100;
  }

  // 7. Search Tokens & Phonetic Keys
  const nameParts = splitName(investorFullName);
  const fullNameNorm = investorFullName.toLowerCase();
  const firstNameNorm = nameParts.first.toLowerCase();
  const middleNameNorm = nameParts.middle.toLowerCase();
  const lastNameNorm = nameParts.last.toLowerCase();

  const firstNameKey = phoneticKeys(nameParts.first);
  const middleNameKey = phoneticKeys(nameParts.middle);
  const lastNameKey = phoneticKeys(nameParts.last);

  // Cluster ID: sha256 of name, relative, state, pin, city
  const investorClusterId = createHash("sha256")
    .update(`${investorFullName}|${relative.value ?? ""}|${state}|${pinDigits}|${city}`)
    .digest("hex")
    .slice(0, 32);

  const validationStatus = statusOf(issues);
  const reviewStatus = validationStatus === "QUARANTINED" ? "QUARANTINED" : "PUBLISHED";

  return {
    batchRunId: context.batchRunId,
    sourceCompany: context.companyName,
    sourceRta: context.sourceRta,
    sourceFileName: context.sourceFileName,
    companyId: context.companyId,
    investorFirstName: nameParts.first,
    investorMiddleName: nameParts.middle || null,
    investorLastName: nameParts.last || null,
    investorFullName,
    fatherOrSpouseName: relative.value,
    fatherOrSpouseRaw: fatherRaw || null,
    addressLine: addressLine || null,
    city: city || null,
    state,
    pincode: pinDigits || null,
    folioNumber: encryptField(folio, context.keys),
    folioNumberMasked: maskFolio(folio),
    folioNumberHash: blindIndex(folio, context.keys),
    certificateNumbers: null,
    originalShares,
    postActionShares: originalShares,
    rawAmount: unclaimedDividendAmount,
    amountsByEvent,
    custodyStatus: "IEPF_AUTHORITY",
    eventDate,
    transferFinancialYear: fy,
    investmentType: "Amount for unclaimed and unpaid dividend",
    sourceFilingSrn: null,
    fullNameNorm,
    firstNameNorm,
    middleNameNorm,
    lastNameNorm,
    firstNameKey,
    middleNameKey,
    lastNameKey,
    ingestionJobId: context.batchRunId,
    validationStatus,
    validationIssues: issues,
    reviewStatus,
    sourceDocumentId: context.sourceDocumentId ?? null,
    sourceRowIds: [],
    quantityBasis: originalShares > 0 ? "SHARES_AS_STATED" : "AMOUNT_ONLY",
    quantityEffectiveDate: eventDate,
  };
}
