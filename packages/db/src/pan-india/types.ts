import type { IndianState } from "@finsol/shared";
import type { StagedFolio } from "../bulk-copy.js";

/** Raw record from any RTA spreadsheet, CSV, or portal export */
export interface RawInputRow {
  [key: string]: unknown;
}

/** Company metadata for target RTA registries */
export interface TargetCompany {
  name: string;
  cin?: string;
  isin?: string;
  nseSymbol?: string;
  bseCode?: string;
  rta: "KFINTECH" | "LINK_INTIME" | "IN_HOUSE" | "OTHER";
  iepfRegistryUrl?: string;
  sampleFile?: string;
}

/** Standardized normalized record ready for database encryption and staging */
export interface NormalizedFolioRecord extends StagedFolio {
  batchRunId: string;
  sourceCompany: string;
  sourceRta: string;
  sourceFileName: string;
  rawAmount?: number;
}

/** Result statistics for a chunk or batch execution */
export interface BatchExecutionResult {
  batchRunId: string;
  sourceCompany: string;
  sourceRta: string;
  sourceFile: string;
  totalRows: number;
  validRows: number;
  warningRows: number;
  quarantinedRows: number;
  insertedRows: number;
  updatedRows: number;
  totalShares: number;
  totalAmountRupees: number;
  peakMemoryMb: number;
  durationMs: number;
  status: "COMPLETED" | "FAILED" | "ROLLED_BACK";
  error?: string;
}

/** Interface for all RTA portal adapters */
export interface RtaAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly rtaType: "KFINTECH" | "LINK_INTIME" | "IN_HOUSE" | "OTHER";

  /** Discovers candidate published files or endpoints for target companies */
  discover(options?: { limit?: number; companyQuery?: string }): Promise<TargetCompany[]>;

  /** Generates or retrieves sample IEPF-2 test datasets for streaming verification */
  getSampleFiles(): Array<{
    company: TargetCompany;
    filePath?: string;
    generateRows?: (count: number) => RawInputRow[];
  }>;
}

/** Options for streaming chunk processor */
export interface ChunkStreamingOptions {
  chunkSize?: number;
  concurrency?: number;
  batchRunId?: string;
  dryRun?: boolean;
  onChunkProcessed?: (chunkIndex: number, rowCount: number, memoryMb: number) => void;
}
