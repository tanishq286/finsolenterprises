import {
  createPrismaClient,
  PanIndiaIngestionEngine,
  type BatchExecutionResult,
  type ChunkStreamingOptions,
  type TargetCompany,
} from "@finsol/db";

export interface HarvesterRunOptions {
  limit?: number;
  rta?: "KFINTECH" | "LINK_INTIME" | "OTHER" | "ALL";
  query?: string;
  rowsPerCompany?: number;
  chunkSize?: number;
  dryRun?: boolean;
}

export class PanIndiaHarvester {
  private readonly db = createPrismaClient();
  private readonly engine: PanIndiaIngestionEngine;

  constructor() {
    this.engine = new PanIndiaIngestionEngine(this.db);
  }

  async run(options: HarvesterRunOptions = {}): Promise<{
    results: BatchExecutionResult[];
    totalIngested: number;
    totalValid: number;
    totalQuarantined: number;
    peakMemoryMb: number;
    durationMs: number;
  }> {
    const rowsPerCompany = options.rowsPerCompany ?? 1000;
    const chunkSize = options.chunkSize ?? 5000;

    console.log(`[PanIndiaHarvester] Discovering candidate companies (RTA: ${options.rta ?? "ALL"}, Query: ${options.query ?? "none"})...`);
    const companies = await this.engine.discover({
      rta: options.rta,
      companyQuery: options.query,
      limit: options.limit,
    });

    console.log(`[PanIndiaHarvester] Discovered ${companies.length} target companies for Pan-India ingestion.`);

    const streamingOpts: ChunkStreamingOptions = {
      chunkSize,
      dryRun: options.dryRun,
      onChunkProcessed: (chunkIdx, rowCount, memMb) => {
        console.log(`  -> Processed chunk #${chunkIdx + 1} (${rowCount} rows, Peak Heap: ${memMb} MB)`);
      },
    };

    return this.engine.harvestBatch(companies, rowsPerCompany, streamingOpts);
  }

  async rollback(batchRunId: string): Promise<{ deletedCount: number }> {
    console.log(`[PanIndiaHarvester] Initiating rollback for batch: ${batchRunId}...`);
    return this.engine.rollback(batchRunId);
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
  }
}
