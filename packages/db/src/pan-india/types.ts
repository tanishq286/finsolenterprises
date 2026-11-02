/**
 * Pan-India harvesting works only from real, attributable sources:
 *
 * - Statements a company publishes itself under the IEPF Rules, found on its
 *   investor-relations pages by the acquisition worker (robots.txt honoured,
 *   one request at a time per host, 401/403/429 recorded and never bypassed).
 * - Files a person downloads from the company's own site into the drop
 *   folder, with a manifest naming the company and where the file came from.
 *
 * The registrars' (KFin Technologies, MUFG Intime) investor portals are
 * per-holder lookups behind a CAPTCHA, not bulk publications; they are not
 * scraped. A registrar adapter therefore selects the issuers that registrar
 * serves (as recorded in the source register) and queues discovery of the
 * statements those issuers publish.
 *
 * No adapter generates rows. A source that yields nothing yields nothing.
 */

export type RegistrarKey = "KFINTECH" | "LINK_INTIME";

/** One issuer selected for harvesting, as the source register records it. */
export interface HarvestTarget {
  registerId: string;
  name: string;
  nseSymbol: string | null;
  isin: string | null;
  registrar: string | null;
  website: string | null;
  irUrl: string | null;
  companyId: string | null;
}

export interface SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Issuers this adapter covers, from the source register (no network access). */
  targets(options?: { limit?: number; query?: string }): Promise<HarvestTarget[]>;
}

/** Drop-folder manifest entry: who published the file, and where it came from. */
export interface ManifestEntry {
  /** File name inside the drop folder. */
  file: string;
  /** NSE symbol, ISIN or CIN of the company; it must be in the catalogue or the register. */
  company: string;
  /** The page or file URL on the company's own website. */
  sourceUrl: string;
  /** ISO date the file was downloaded. */
  retrievedAt: string;
  /** e.g. "FY 2024-25" or "as on 31.03.2023". */
  reportingPeriod?: string;
  /** Share lists only: whether the shares were transferred or are only due. */
  shareBasis?: "PROPOSED_IEPF_TRANSFER" | "TRANSFERRED_TO_IEPF";
}

export interface FileHarvestResult {
  file: string;
  company: string;
  companyId: string | null;
  batchRunId: string | null;
  status: "IMPORTED" | "ALREADY_IMPORTED" | "DRY_RUN" | "FAILED" | "UNSUPPORTED";
  detail?: string;
  bytes: number;
  totalRows: number;
  validRows: number;
  warningRows: number;
  quarantinedRows: number;
  insertedRows: number;
  updatedRows: number;
  amountTotal: number;
  chunks: number;
  peakRssMb: number;
  peakHeapMb: number;
  durationMs: number;
}
