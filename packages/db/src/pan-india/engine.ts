import type { PrismaClient } from "../generated/prisma/client.js";
import { BlueChipsAdapter } from "./adapters/blue-chips.js";
import { KFintechAdapter } from "./adapters/kfintech.js";
import { LinkIntimeAdapter } from "./adapters/link-intime.js";
import { PanIndiaPipeline } from "./pipeline.js";
import type {
  BatchExecutionResult,
  ChunkStreamingOptions,
  RtaAdapter,
  TargetCompany,
} from "./types.js";

export class PanIndiaIngestionEngine {
  private readonly adapters: Map<string, RtaAdapter> = new Map();
  private readonly pipeline: PanIndiaPipeline;

  constructor(
    private readonly prisma: PrismaClient,
    options?: {
      pipeline?: PanIndiaPipeline;
      databaseUrl?: string;
    },
  ) {
    this.pipeline = options?.pipeline ?? new PanIndiaPipeline(prisma, { databaseUrl: options?.databaseUrl });
    this.registerAdapter(new KFintechAdapter());
    this.registerAdapter(new LinkIntimeAdapter());
    this.registerAdapter(new BlueChipsAdapter());
  }

  registerAdapter(adapter: RtaAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): RtaAdapter | undefined {
    return this.adapters.get(id);
  }

  getAllAdapters(): RtaAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Discovers candidate companies across all or selected RTA adapters
   */
  async discover(options?: {
    rta?: "KFINTECH" | "LINK_INTIME" | "OTHER" | "ALL";
    companyQuery?: string;
    limit?: number;
  }): Promise<TargetCompany[]> {
    const results: TargetCompany[] = [];
    const adaptersToQuery = this.getAllAdapters().filter((a) => {
      if (!options?.rta || options.rta === "ALL") return true;
      if (options.rta === "KFINTECH" && a.id === "kfintech") return true;
      if (options.rta === "LINK_INTIME" && a.id === "link_intime") return true;
      if (options.rta === "OTHER" && a.id === "blue_chips") return true;
      return false;
    });

    for (const adapter of adaptersToQuery) {
      const companies = await adapter.discover({
        companyQuery: options?.companyQuery,
        limit: options?.limit,
      });
      results.push(...companies);
    }

    if (options?.limit && options.limit > 0) {
      return results.slice(0, options.limit);
    }
    return results;
  }

  /**
   * Harvests IEPF-2 records for a single target company using its RTA adapter sample generator
   */
  async harvestCompany(
    target: TargetCompany,
    sampleRowCount = 1000,
    options?: ChunkStreamingOptions,
  ): Promise<BatchExecutionResult> {
    const adapter =
      target.rta === "KFINTECH"
        ? this.getAdapter("kfintech")
        : target.rta === "LINK_INTIME"
          ? this.getAdapter("link_intime")
          : this.getAdapter("blue_chips");

    if (!adapter) {
      throw new Error(`No adapter found for company ${target.name} (${target.rta})`);
    }

    const samples = adapter.getSampleFiles();
    const match = samples.find((s) => s.company.name === target.name) ?? samples[0];

    if (!match?.generateRows) {
      throw new Error(`Adapter for ${target.name} has no row generator`);
    }

    const rawRows = match.generateRows(sampleRowCount);
    const headers = rawRows.length > 0 ? Object.keys(rawRows[0]!) : [];

    return this.pipeline.ingestCompanyRows(target, rawRows, headers, options);
  }

  /**
   * Harvests a batch of companies in streaming chunks with summary logging
   */
  async harvestBatch(
    companies: TargetCompany[],
    rowsPerCompany = 1000,
    options?: ChunkStreamingOptions,
  ): Promise<{
    results: BatchExecutionResult[];
    totalIngested: number;
    totalValid: number;
    totalQuarantined: number;
    peakMemoryMb: number;
    durationMs: number;
  }> {
    const started = performance.now();
    const results: BatchExecutionResult[] = [];
    let peakMemoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));

    for (const company of companies) {
      const res = await this.harvestCompany(company, rowsPerCompany, options);
      results.push(res);
      if (res.peakMemoryMb > peakMemoryMb) {
        peakMemoryMb = res.peakMemoryMb;
      }
    }

    const totalIngested = results.reduce((acc, r) => acc + r.insertedRows, 0);
    const totalValid = results.reduce((acc, r) => acc + r.validRows, 0);
    const totalQuarantined = results.reduce((acc, r) => acc + r.quarantinedRows, 0);
    const durationMs = Math.round(performance.now() - started);

    return {
      results,
      totalIngested,
      totalValid,
      totalQuarantined,
      peakMemoryMb,
      durationMs,
    };
  }

  /**
   * Rollback a batch by ID
   */
  async rollback(batchRunId: string): Promise<{ deletedCount: number }> {
    return this.pipeline.rollbackBatch(batchRunId);
  }
}
