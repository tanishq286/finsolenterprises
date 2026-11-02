/**
 * Domain enums. Each one is a readonly tuple (the single source of truth),
 * a union type derived from it, and display labels. The Prisma schema mirrors
 * these names exactly; `test/enums.test.ts` keeps the two in step.
 */

export const ROLES = [
  "INVESTOR",
  "ASSOCIATE_PARTNER",
  "VALUATION_ANALYST",
  "LEGAL_OPS_EXEC",
  "SUPER_ADMIN",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  INVESTOR: "Investor",
  ASSOCIATE_PARTNER: "Associate partner",
  VALUATION_ANALYST: "Valuation analyst",
  LEGAL_OPS_EXEC: "Legal operations",
  SUPER_ADMIN: "Administrator",
};

/** Staff who work leads and cases. */
export const STAFF_ROLES = [
  "VALUATION_ANALYST",
  "LEGAL_OPS_EXEC",
  "SUPER_ADMIN",
] as const satisfies readonly Role[];

/** The 28 states and 8 union territories, plus holders with an address outside India. */
export const INDIAN_STATES = [
  "ANDHRA_PRADESH",
  "ARUNACHAL_PRADESH",
  "ASSAM",
  "BIHAR",
  "CHHATTISGARH",
  "GOA",
  "GUJARAT",
  "HARYANA",
  "HIMACHAL_PRADESH",
  "JHARKHAND",
  "KARNATAKA",
  "KERALA",
  "MADHYA_PRADESH",
  "MAHARASHTRA",
  "MANIPUR",
  "MEGHALAYA",
  "MIZORAM",
  "NAGALAND",
  "ODISHA",
  "PUNJAB",
  "RAJASTHAN",
  "SIKKIM",
  "TAMIL_NADU",
  "TELANGANA",
  "TRIPURA",
  "UTTAR_PRADESH",
  "UTTARAKHAND",
  "WEST_BENGAL",
  "ANDAMAN_AND_NICOBAR_ISLANDS",
  "CHANDIGARH",
  "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU",
  "DELHI",
  "JAMMU_AND_KASHMIR",
  "LADAKH",
  "LAKSHADWEEP",
  "PUDUCHERRY",
  "OUT_OF_INDIA",
] as const;
export type IndianState = (typeof INDIAN_STATES)[number];

export const STATE_LABELS: Record<IndianState, string> = {
  ANDHRA_PRADESH: "Andhra Pradesh",
  ARUNACHAL_PRADESH: "Arunachal Pradesh",
  ASSAM: "Assam",
  BIHAR: "Bihar",
  CHHATTISGARH: "Chhattisgarh",
  GOA: "Goa",
  GUJARAT: "Gujarat",
  HARYANA: "Haryana",
  HIMACHAL_PRADESH: "Himachal Pradesh",
  JHARKHAND: "Jharkhand",
  KARNATAKA: "Karnataka",
  KERALA: "Kerala",
  MADHYA_PRADESH: "Madhya Pradesh",
  MAHARASHTRA: "Maharashtra",
  MANIPUR: "Manipur",
  MEGHALAYA: "Meghalaya",
  MIZORAM: "Mizoram",
  NAGALAND: "Nagaland",
  ODISHA: "Odisha",
  PUNJAB: "Punjab",
  RAJASTHAN: "Rajasthan",
  SIKKIM: "Sikkim",
  TAMIL_NADU: "Tamil Nadu",
  TELANGANA: "Telangana",
  TRIPURA: "Tripura",
  UTTAR_PRADESH: "Uttar Pradesh",
  UTTARAKHAND: "Uttarakhand",
  WEST_BENGAL: "West Bengal",
  ANDAMAN_AND_NICOBAR_ISLANDS: "Andaman and Nicobar Islands",
  CHANDIGARH: "Chandigarh",
  DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU: "Dadra and Nagar Haveli and Daman and Diu",
  DELHI: "Delhi",
  JAMMU_AND_KASHMIR: "Jammu and Kashmir",
  LADAKH: "Ladakh",
  LAKSHADWEEP: "Lakshadweep",
  PUDUCHERRY: "Puducherry",
  OUT_OF_INDIA: "Outside India",
};

export function isIndianState(value: unknown): value is IndianState {
  return typeof value === "string" && (INDIAN_STATES as readonly string[]).includes(value);
}

/**
 * Matches a state written the way IEPF-2/IEPF-4 filings write it ("MAHARASHTRA",
 * "Tamil Nadu", "NCT of Delhi", "Orissa", "Pondicherry", "Foreign") to the enum.
 */
export function parseIndianState(raw: string | null | undefined): IndianState | null {
  if (!raw) return null;
  const key = raw
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return null;
  const aliases: Record<string, IndianState> = {
    ORISSA: "ODISHA",
    PONDICHERRY: "PUDUCHERRY",
    "NCT OF DELHI": "DELHI",
    "NEW DELHI": "DELHI",
    "DELHI NCT": "DELHI",
    UTTARANCHAL: "UTTARAKHAND",
    "JAMMU KASHMIR": "JAMMU_AND_KASHMIR",
    "ANDAMAN NICOBAR": "ANDAMAN_AND_NICOBAR_ISLANDS",
    "ANDAMAN AND NICOBAR": "ANDAMAN_AND_NICOBAR_ISLANDS",
    "DADRA AND NAGAR HAVELI": "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU",
    "DADAR NAGAR HAVELI": "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU",
    "DADRA NAGAR HAVELI": "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU",
    "DAMAN AND DIU": "DADRA_AND_NAGAR_HAVELI_AND_DAMAN_AND_DIU",
    FOREIGN: "OUT_OF_INDIA",
    "FOREIGN COUNTRY": "OUT_OF_INDIA",
    "OUTSIDE INDIA": "OUT_OF_INDIA",
    NRI: "OUT_OF_INDIA",
  };
  if (aliases[key]) return aliases[key];
  const underscored = key.replace(/ /g, "_");
  return isIndianState(underscored) ? underscored : null;
}

export const RTA_NAMES = [
  "KFIN",
  "LINK_INTIME",
  "BIGSHARE",
  "ALANKIT",
  "INTEGRATED",
  "DATAMATICS",
  "CAMEO",
  "IN_HOUSE",
  "OTHER",
] as const;
export type RtaName = (typeof RTA_NAMES)[number];

export const RTA_LABELS: Record<RtaName, string> = {
  KFIN: "KFin Technologies",
  LINK_INTIME: "MUFG Intime (Link Intime)",
  BIGSHARE: "Bigshare Services",
  ALANKIT: "Alankit Assignments",
  INTEGRATED: "Integrated Registry Management Services",
  DATAMATICS: "Datamatics Business Solutions",
  CAMEO: "Cameo Corporate Services",
  IN_HOUSE: "Company's own share department",
  OTHER: "Other registrar",
};

export const CUSTODY_STATUSES = [
  "IEPF_AUTHORITY",
  "COMPANY_SUSPENSE",
  "PHYSICAL_DORMANT",
  "DUE_FOR_IEPF_TRANSFER",
] as const;
export type CustodyStatus = (typeof CUSTODY_STATUSES)[number];

export const CUSTODY_LABELS: Record<CustodyStatus, string> = {
  IEPF_AUTHORITY: "With the IEPF Authority",
  COMPANY_SUSPENSE: "In the company's suspense account",
  PHYSICAL_DORMANT: "Physical shares, dividends unclaimed",
  DUE_FOR_IEPF_TRANSFER: "Listed as due for transfer to the IEPF",
};

/**
 * CASH_ENTITLEMENT: cash per equity share that is not a dividend, e.g. bonus
 * preference shares later redeemed in cash. It never changes the share count.
 */
export const CORPORATE_ACTION_TYPES = [
  "BONUS",
  "SPLIT",
  "MERGER",
  "DIVIDEND",
  "CASH_ENTITLEMENT",
] as const;
export type CorporateActionType = (typeof CORPORATE_ACTION_TYPES)[number];

export const RELATIONSHIPS = ["SELF", "SON_DAUGHTER", "SPOUSE", "LEGAL_HEIR", "ADVISOR"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  SELF: "I am the holder",
  SON_DAUGHTER: "Son or daughter",
  SPOUSE: "Spouse",
  LEGAL_HEIR: "Other legal heir",
  ADVISOR: "Advisor (CA, CS, lawyer)",
};

export const PHYSICAL_CERT_STATUSES = ["AVAILABLE", "LOST", "PARTIAL"] as const;
export type PhysicalCertStatus = (typeof PHYSICAL_CERT_STATUSES)[number];

export const PHYSICAL_CERT_LABELS: Record<PhysicalCertStatus, string> = {
  AVAILABLE: "I have the certificates",
  LOST: "Certificates are lost",
  PARTIAL: "I have some of them",
};

export const CRM_STAGES = [
  "NEW_SEARCH_LEAD",
  "RING_UP_DONE",
  "EVALUATION_IN_PROGRESS",
  "FEASIBILITY_CHECKED",
  "OFFER_SENT",
  "CONVERTED_TO_CASE",
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export const CRM_STAGE_LABELS: Record<CrmStage, string> = {
  NEW_SEARCH_LEAD: "New search lead",
  RING_UP_DONE: "Rung up",
  EVALUATION_IN_PROGRESS: "Evaluating",
  FEASIBILITY_CHECKED: "Feasibility checked",
  OFFER_SENT: "Offer sent",
  CONVERTED_TO_CASE: "Converted to case",
};

export const SCENARIO_TYPES = [
  "STANDARD_IEPF5",
  "DUPLICATE_LOC",
  "DECEASED_TRANSMISSION",
  "NRI_RECOVERY",
  "DEMAT_DRF",
] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

export const SCENARIO_LABELS: Record<ScenarioType, string> = {
  STANDARD_IEPF5: "IEPF-5 claim",
  DUPLICATE_LOC: "Duplicate shares (letter of confirmation)",
  DECEASED_TRANSMISSION: "Transmission after a death",
  NRI_RECOVERY: "Recovery for a holder abroad",
  DEMAT_DRF: "Physical to demat (DRF)",
};

export const ESIGN_STATUSES = ["PENDING", "SIGNED"] as const;
export type EsignStatus = (typeof ESIGN_STATUSES)[number];

export const DOC_TYPES = [
  "PAN",
  "AADHAAR",
  "CML_COPY",
  "CANCELLED_CHEQUE",
  "ORIGINAL_CERT_OR_FIR",
  "ISR1_ISR2_KYC",
  "INDEMNITY_BOND",
  "DEATH_CERTIFICATE",
  "LEGAL_HEIR_OR_SUCCESSION_CERT",
  "IEPF5_ACKNOWLEDGEMENT",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  PAN: "PAN card",
  AADHAAR: "Aadhaar (masked)",
  CML_COPY: "Client master list (CML) of your demat account",
  CANCELLED_CHEQUE: "Cancelled cheque",
  ORIGINAL_CERT_OR_FIR: "Original certificates, or FIR for lost ones",
  ISR1_ISR2_KYC: "Forms ISR-1 and ISR-2 (KYC and signature)",
  INDEMNITY_BOND: "Indemnity bond",
  DEATH_CERTIFICATE: "Death certificate",
  LEGAL_HEIR_OR_SUCCESSION_CERT: "Legal heir or succession certificate",
  IEPF5_ACKNOWLEDGEMENT: "IEPF-5 acknowledgement (SRN)",
};

export const DOC_STATUSES = ["PENDING", "UPLOADED", "VERIFIED", "REJECTED"] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];

export const PROFESSIONS = ["CA", "CS", "ADVOCATE", "WEALTH_ADVISOR", "EX_BANKER"] as const;
export type Profession = (typeof PROFESSIONS)[number];

export const PROFESSION_LABELS: Record<Profession, string> = {
  CA: "Chartered accountant",
  CS: "Company secretary",
  ADVOCATE: "Advocate",
  WEALTH_ADVISOR: "Wealth advisor",
  EX_BANKER: "Former banker",
};

/** Status of the RTA entitlement letter, nodal verification and demat credit. */
export const TRACK_STATUSES = [
  "NOT_STARTED",
  "REQUESTED",
  "IN_PROGRESS",
  "QUERY_RAISED",
  "DONE",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export const TRACK_LABELS: Record<TrackStatus, string> = {
  NOT_STARTED: "Not started",
  REQUESTED: "Requested",
  IN_PROGRESS: "In progress",
  QUERY_RAISED: "Query raised",
  DONE: "Done",
};

export const INGESTION_FORMS = ["IEPF_2", "IEPF_4"] as const;
export type IngestionForm = (typeof INGESTION_FORMS)[number];

export const INGESTION_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export const LEDGER_ENTRY_TYPES = ["ACCRUAL", "PAYOUT", "ADJUSTMENT"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * Folios whose statement gives no state (many IEPF-2 lists carry only a name,
 * folio and amount) and no PIN code to derive one from. They are not dropped:
 * search shows them whatever state is chosen, labelled as such.
 */
export const STATE_NOT_STATED = "UNKNOWN" as const;
export type FolioState = IndianState | typeof STATE_NOT_STATED;

export function folioStateLabel(s: FolioState): string {
  return s === STATE_NOT_STATED ? "State not on the statement" : STATE_LABELS[s];
}

const PIN_RANGES: [number, number, IndianState][] = [
  [110, 110, "DELHI"],
  [121, 136, "HARYANA"],
  [140, 159, "PUNJAB"],
  [160, 160, "CHANDIGARH"],
  [171, 177, "HIMACHAL_PRADESH"],
  [180, 193, "JAMMU_AND_KASHMIR"],
  [194, 194, "LADAKH"],
  [201, 285, "UTTAR_PRADESH"],
  [301, 345, "RAJASTHAN"],
  [360, 396, "GUJARAT"],
  [400, 445, "MAHARASHTRA"],
  [450, 488, "MADHYA_PRADESH"],
  [490, 497, "CHHATTISGARH"],
  [500, 509, "TELANGANA"],
  [515, 535, "ANDHRA_PRADESH"],
  [560, 591, "KARNATAKA"],
  [600, 643, "TAMIL_NADU"],
  [670, 695, "KERALA"],
  [700, 743, "WEST_BENGAL"],
  [751, 770, "ODISHA"],
  [781, 788, "ASSAM"],
  [790, 792, "ARUNACHAL_PRADESH"],
  [793, 794, "MEGHALAYA"],
  [795, 795, "MANIPUR"],
  [796, 796, "MIZORAM"],
  [797, 798, "NAGALAND"],
  [799, 799, "TRIPURA"],
  [800, 855, "BIHAR"],
];
const PIN_OVERRIDES: Record<number, IndianState> = {
  246: "UTTARAKHAND",
  248: "UTTARAKHAND",
  249: "UTTARAKHAND",
  262: "UTTARAKHAND",
  263: "UTTARAKHAND",
  403: "GOA",
  737: "SIKKIM",
  744: "ANDAMAN_AND_NICOBAR_ISLANDS",
  814: "JHARKHAND",
  815: "JHARKHAND",
  816: "JHARKHAND",
  822: "JHARKHAND",
  825: "JHARKHAND",
  826: "JHARKHAND",
  827: "JHARKHAND",
  828: "JHARKHAND",
  829: "JHARKHAND",
  831: "JHARKHAND",
  832: "JHARKHAND",
  833: "JHARKHAND",
  834: "JHARKHAND",
  835: "JHARKHAND",
};

/**
 * The state for a 6-digit Indian PIN code, from its first three digits
 * (postal circles). Border districts that share a prefix resolve to the
 * larger state; used only when a statement has no state of its own.
 */
export function stateFromPincode(pin: string | null | undefined): IndianState | null {
  const digits = (pin ?? "").replace(/\D/g, "");
  if (!/^[1-8]\d{5}$/.test(digits)) return null;
  const prefix = Number(digits.slice(0, 3));
  if (PIN_OVERRIDES[prefix]) return PIN_OVERRIDES[prefix];
  return PIN_RANGES.find(([a, b]) => prefix >= a && prefix <= b)?.[2] ?? null;
}
