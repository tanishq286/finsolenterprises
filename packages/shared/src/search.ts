import type {
  FolioState,
  CustodyStatus,
  IndianState,
  PhysicalCertStatus,
  Relationship,
} from "./enums.js";
import { normalizeName, splitName } from "./names.js";

/**
 * The public search contract, shared by the API and the web app.
 * Four ways to search, each scoped to a state:
 *   FULL    first + middle + last (any two or more parts, or a full name)
 *   FIRST   first name only
 *   MIDDLE  middle name only
 *   LAST    last name only (surname)
 */
export type SearchMode = "FULL" | "FIRST" | "MIDDLE" | "LAST";

/** Searches every state partition at once, for families who moved across states. */
export const ALL_INDIA = "ALL_INDIA" as const;
export type SearchScope = IndianState | typeof ALL_INDIA;

export interface SearchInput {
  /** A second name to check, e.g. a joint holder or another family member. */
  jointHolderName?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  fullName?: string;
  state: SearchScope;
  custodyStatus?: CustodyStatus;
}

export interface ResolvedSearch {
  mode: SearchMode;
  first: string;
  middle: string;
  last: string;
  state: SearchScope;
  custodyStatus?: CustodyStatus;
  /**
   * One word typed into the single name box. It could be any part of a name
   * (people often type just the surname), so it is searched as first, middle
   * and last name.
   */
  singleWord?: boolean;
}

/** The three searches a single typed word stands for: as surname, first name and middle name. */
export function expandSingleWord(q: ResolvedSearch): ResolvedSearch[] {
  if (!q.singleWord) return [q];
  const w = q.first || q.middle || q.last;
  const base = { state: q.state, custodyStatus: q.custodyStatus };
  return [
    { ...base, mode: "LAST", first: "", middle: "", last: w },
    { ...base, mode: "FIRST", first: w, middle: "", last: "" },
    { ...base, mode: "MIDDLE", first: "", middle: w, last: "" },
  ];
}

/** Works out which of the four searches the input asks for, or null when no name was given. */
export function resolveSearch(input: SearchInput): ResolvedSearch | null {
  let first = normalizeName(input.firstName);
  let middle = normalizeName(input.middleName);
  let last = normalizeName(input.lastName);
  let singleWord = false;
  if (!first && !middle && !last && input.fullName) {
    const parts = splitName(input.fullName);
    first = parts.first;
    middle = parts.middle;
    last = parts.last;
    singleWord = !!first && !middle && !last && first.length > 1;
  }
  const given = [first, middle, last].filter(Boolean).length;
  if (given === 0) return null;
  const mode: SearchMode = given >= 2 ? "FULL" : first ? "FIRST" : middle ? "MIDDLE" : "LAST";
  return {
    mode,
    first,
    middle,
    last,
    state: input.state,
    custodyStatus: input.custodyStatus,
    ...(singleWord ? { singleWord } : {}),
  };
}

/**
 * Who is looking decides what a result reveals:
 *   public  holder name and place only; company and folio masked, no shares or value
 *   member  signed in through the Login Gateway: company, shares and value; the
 *           folio stays masked until an analyst releases it in the CRM
 *   staff   everything
 */
export type ResultAccess = "public" | "member" | "staff";

export interface SearchResultItem {
  id: string;
  access: ResultAccess;
  investorFullName: string;
  fatherOrSpouseName: string | null;
  city: string | null;
  /** "400***": enough to tell namesakes apart without exposing the address. */
  pincodeMasked: string | null;
  /**
   * Record group: a hash of name, father/spouse, PIN, city and state, used to
   * group lines of the same statement entry. It is not proof of identity:
   * different groups may still relate to the same person, and one group can
   * hold namesakes. Identity is verified separately, by people.
   */
  investorClusterId: string;
  /** The holder's state, or UNKNOWN when the statement gives none. */
  state: FolioState;
  custodyStatus: CustodyStatus;
  /** "R******e Industries Ltd" for the public. */
  companyName: string;
  /** Null for the public. */
  companySlug: string | null;
  /** "RIL***21" unless released to this client or the viewer is staff. */
  folioNumber: string;
  folioReleased: boolean;
  /** Shares after bonuses and splits. Null for the public, and when the statement states no share count. */
  postActionShares: number | null;
  /** True when the statement lists a share count; false for amount-only (IEPF-2 dividend) records. */
  sharesStated: boolean;
  /** "SHARES" or "UNCLAIMED_AMOUNT" (an unclaimed dividend listing with no share count). */
  recordKind: "SHARES" | "UNCLAIMED_AMOUNT";
  /**
   * Shares × the last synced price + unclaimed amounts, in paise. Null for the
   * public, and null when there is no share count or no price (unknown, not zero).
   */
  estimatedTotalValuePaise: number | null;
  /** Last synced market price per share, in paise. Null for the public or before the first sync. */
  sharePricePaise: number | null;
  priceUpdatedAt: string | null;
  unclaimedDividendPaise: number | null;
  eventDate: string | null;
  investmentType: string | null;
  transferFinancialYear: string | null;
  /** Which name on the check matched this row. */
  matchedHolder: "primary" | "joint";
  /** 0..1, how closely the name matched. */
  matchScore: number;
  matchedBy: "exact" | "trigram" | "phonetic" | "sound-alike";
  /**
   * exact:   every name part given matches exactly
   * partial: matched exactly on the one name part given (other parts not checked)
   * variant: a spelling or sound-alike variant, not the name as typed
   */
  matchClass: "exact" | "partial" | "variant";
  /** Statement the record came from, for freshness: its publication and our retrieval. */
  source: { publishedAt: string | null; retrievedAt: string | null } | null;
}

/** What the search covers, shown beside every result list and every "no match". */
export interface SearchCoverage {
  /** Holder records searchable now (one statement entry each; not people, not unique folios). */
  holderRecords: number;
  /**
   * Companies with at least one imported holder record. Empty for the public,
   * whose results mask company names: the count is given instead.
   */
  companiesWithRecords: { name: string; records: number }[];
  companiesWithRecordsCount: number;
  /** Company profiles in the directory (most have no holder records). */
  companyProfiles: number;
  /** Listed equities known to the calculator (no holder data). */
  listedEquities: number;
  /** Most recent statement publication and retrieval among imported sources, when known. */
  latestSourcePublishedAt: string | null;
  latestSourceRetrievedAt: string | null;
  /** Statements whose newest record is older than this many days are described as old. */
  oldestRecordYear: number | null;
  newestRecordYear: number | null;
}

export interface SearchResponse {
  mode: SearchMode;
  query: { first: string; middle: string; last: string; state: SearchScope; jointHolder: string };
  access: ResultAccess;
  total: number;
  results: SearchResultItem[];
  /** Most results returned for one search. */
  limit: number;
  /** True when more records matched than were returned: narrow the search. */
  truncated: boolean;
  /** What these records cover. A "no match" only speaks for this coverage. */
  coverage: SearchCoverage;
  /** How the estimate is worked out, shown under every result list. */
  valuationBasis: string;
  engine: "meilisearch" | "postgres";
  tookMs: number;
  /** Set when a live refresh was started for this name and state; poll or stream it. */
  liveRefreshId: string | null;
}

export interface OtpRequestBody {
  phone: string;
  purpose: "LOGIN";
}

/** A signed-in member asks Finsol to take up the rows they picked. */
export interface ClaimRequestBody {
  folioIds: string[];
  relationshipToHolder: Relationship;
  physicalCertStatus: PhysicalCertStatus;
  referralCode?: string;
  consent: true;
}

export interface ClaimResponse {
  leadId: string;
  folioCount: number;
  /** True when another client already has a case or request on one of these holdings. */
  underReview: boolean;
}

export const VALUATION_BASIS =
  "Estimate = shares after bonuses and splits × the latest available market price (which can be delayed), plus the unclaimed amount the statement lists. Records that list only an unclaimed dividend amount state no share count, so no share value is estimated for them. A listed amount is what the company reported on its statement date, not a confirmed amount payable today. The entitlement is confirmed during verification, and value is fixed only when shares or money are credited.";

/** Said under every search, matched or not. */
export const COVERAGE_DISCLAIMER =
  "These records come only from the statements we have imported. No match here does not mean there are no unclaimed holdings: many companies and years are not covered yet. A match is a lead to verify, not proof of ownership.";

/** Company + folio lookup: an exact match on the folio number printed on the certificate. */
export interface FolioSearchInput {
  company: string;
  folio: string;
  state?: IndianState;
}

/**
 * The public learns only whether a record exists; who it belongs to stays
 * hidden until they sign in, so walking folio numbers reveals no holders.
 */
export interface FolioSearchPresence {
  mode: "COMPANY_FOLIO";
  access: "public";
  companyMatched: boolean;
  found: number;
}

export interface FolioSearchResults {
  mode: "COMPANY_FOLIO";
  access: "member" | "staff";
  companyMatched: boolean;
  found: number;
  results: SearchResultItem[];
}

export type FolioSearchResponse = FolioSearchPresence | FolioSearchResults;

const COMPANY_NOISE = new Set(["limited", "ltd", "the", "pvt", "private", "inc"]);
export const COMPANY_QUERY_MAX = 80;

/** "The Reliance Industries Ltd." -> "reliance industries": for matching and demand counts. */
export function normalizeCompanyQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !COMPANY_NOISE.has(w))
    .join(" ")
    .slice(0, COMPANY_QUERY_MAX)
    .trim();
}

/**
 * The spellings of a typed folio worth an exact lookup: as typed, and without
 * separators. Case and spaces are folded later by the keyed hash itself.
 */
export function folioVariants(raw: string): string[] {
  const typed = raw.trim();
  const bare = typed.replace(/[-/._]/g, "");
  return [...new Set([typed, bare].filter((v) => v.replace(/\s+/g, "").length > 0))];
}

/** Staff view of zero-result searches: what people looked for that we could not find. */
export interface SearchDemandReport {
  days: number;
  since: string;
  zeroResultSearches: number;
  /** Folio lookups for companies not in our records, most asked first. */
  uncoveredCompanies: { companyQuery: string; searches: number; searchers: number }[];
  /** Folio lookups for companies we cover, where the folio was not in our records. */
  coveredCompaniesMissingFolio: { companyQuery: string; searches: number; searchers: number }[];
  /** Zero-result searches by state; null is All India. */
  byState: { state: IndianState | null; searches: number; searchers: number }[];
}
