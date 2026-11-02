import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import pg from "pg";
import { bulkUpsertFolios, type StagedFolio } from "../bulk-copy.js";
import { keysFromEnv, type FieldKeys } from "../crypto.js";
import { LOCAL_DATABASE_URL } from "../local-url.js";
import { HeaderMapper, normalizeFolioRow } from "./normalizer.js";
import { streamRowsInChunks } from "./streaming-chunker.js";
import type {
  BatchExecutionResult,
  ChunkStreamingOptions,
  NormalizedFolioRecord,
  RawInputRow,
  TargetCompany,
} from "./types.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export class PanIndiaPipeline {
  private readonly keys: FieldKeys;
  private readonly dbUrl: string;

  constructor(
    private readonly prisma: PrismaClient,
    options?: { keys?: FieldKeys; databaseUrl?: string },
  ) {
    this.keys = options?.keys ?? keysFromEnv();
    this.dbUrl =
      options?.databaseUrl ??
      process.env.DATABASE_URL ??
      LOCAL_DATABASE_URL;
  }

  /**
   * Resolves existing company or creates entry with RTA metadata
   */
  async resolveCompany(target: TargetCompany): Promise<string> {
    const slug = slugify(target.name);
    const existing = await this.prisma.company.findFirst({
      where: {
        OR: [
          ...(target.cin ? [{ cin: target.cin }] : []),
          ...(target.isin ? [{ isin: target.isin }] : []),
          { slug },
        ],
      },
      select: { id: true },
    });

    if (existing) return existing.id;

    const rtaEnum =
      target.rta === "KFINTECH"
        ? "KFIN"
        : target.rta === "LINK_INTIME"
          ? "LINK_INTIME"
          : target.rta === "IN_HOUSE"
            ? "IN_HOUSE"
            : "OTHER";

    const created = await this.prisma.company.create({
      data: {
        name: target.name,
        slug,
        cin: target.cin ?? null,
        isin: target.isin ?? null,
        tickerNse: target.nseSymbol ?? null,
        tickerBse: target.bseCode ?? null,
        rtaName: rtaEnum,
        nodalOfficerName: "Nodal Officer (IEPF)",
        contactsSource: `RTA Registry Portal - ${target.rta}`,
        irPageUrl: target.iepfRegistryUrl ?? null,
      },
      select: { id: true },
    });

    return created.id;
  }

  /**
   * Ingests a streaming iterable of raw rows for a target company in chunks
   */
  async ingestCompanyRows(
    target: TargetCompany,
    rowGenerator: Iterable<RawInputRow> | AsyncIterable<RawInputRow>,
    headers: string[],
    options?: ChunkStreamingOptions,
  ): Promise<BatchExecutionResult> {
    const batchRunId = options?.batchRunId ?? randomUUID();
    const chunkSize = options?.chunkSize ?? 5000;
    const startedAt = performance.now();
    let peakMemoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));

    const companyId = await this.resolveCompany(target);

    // Record IngestionJob
    await this.prisma.ingestionJob.create({
      data: {
        id: batchRunId,
        formType: "IEPF_2",
        fileName: `${slugify(target.name)}_iepf2.xlsx`,
        storageKey: `harvest:${target.rta.toLowerCase()}:${batchRunId}`,
        sourceUrl: target.iepfRegistryUrl ?? `harvest:${target.rta.toLowerCase()}`,
        companyId,
        status: "PROCESSING",
        startedAt: new Date(),
      },
    });

    let totalRows = 0;
    let validRows = 0;
    let warningRows = 0;
    let quarantinedRows = 0;
    let insertedRows = 0;
    let updatedRows = 0;
    let totalShares = 0;
    let totalAmountRupees = 0;

    try {
      const chunkStream = streamRowsInChunks(rowGenerator, headers, chunkSize);

      for await (const chunk of chunkStream) {
        if (chunk.memoryMb > peakMemoryMb) {
          peakMemoryMb = chunk.memoryMb;
        }

        const mapper = new HeaderMapper(chunk.headers);
        const normalizedChunk: NormalizedFolioRecord[] = [];

        for (const raw of chunk.rows) {
          totalRows++;
          const record = normalizeFolioRow(raw, mapper, {
            companyId,
            companyName: target.name,
            sourceRta: target.rta,
            sourceFileName: `${slugify(target.name)}_iepf2.xlsx`,
            batchRunId,
            keys: this.keys,
          });

          if (!record) continue;

          if (record.validationStatus === "VALID") validRows++;
          else if (record.validationStatus === "WARNING") warningRows++;
          else if (record.validationStatus === "QUARANTINED") quarantinedRows++;

          totalShares += record.originalShares;
          const amt = Number(record.rawAmount ?? 0);
          if (!Number.isNaN(amt)) totalAmountRupees += amt;

          normalizedChunk.push(record);
        }

        if (normalizedChunk.length > 0 && !options?.dryRun) {
          const bulkRes = await bulkUpsertFolios(normalizedChunk as StagedFolio[], {
            form: "IEPF_2",
            databaseUrl: this.dbUrl,
          });

          insertedRows += bulkRes.inserted;
          updatedRows += bulkRes.updated;
        }

        options?.onChunkProcessed?.(chunk.chunkIndex, chunk.rows.length, chunk.memoryMb);
      }

      const durationMs = Math.round(performance.now() - startedAt);

      await this.prisma.ingestionJob.update({
        where: { id: batchRunId },
        data: {
          status: "COMPLETED",
          totalRows,
          insertedRows,
          updatedRows,
          skippedRows: quarantinedRows,
          finishedAt: new Date(),
        },
      });

      return {
        batchRunId,
        sourceCompany: target.name,
        sourceRta: target.rta,
        sourceFile: `${slugify(target.name)}_iepf2.xlsx`,
        totalRows,
        validRows,
        warningRows,
        quarantinedRows,
        insertedRows,
        updatedRows,
        totalShares,
        totalAmountRupees: Math.round(totalAmountRupees * 100) / 100,
        peakMemoryMb,
        durationMs,
        status: "COMPLETED",
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      await this.prisma.ingestionJob.update({
        where: { id: batchRunId },
        data: {
          status: "FAILED",
          errors: [{ row: 0, message: errorMsg }],
          finishedAt: new Date(),
        },
      }).catch(() => {});

      return {
        batchRunId,
        sourceCompany: target.name,
        sourceRta: target.rta,
        sourceFile: `${slugify(target.name)}_iepf2.xlsx`,
        totalRows,
        validRows,
        warningRows,
        quarantinedRows,
        insertedRows,
        updatedRows,
        totalShares,
        totalAmountRupees,
        peakMemoryMb,
        durationMs: Math.round(performance.now() - startedAt),
        status: "FAILED",
        error: errorMsg,
      };
    }
  }

  /**
   * Complete transactional rollback for an ingested batch
   */
  async rollbackBatch(batchRunId: string): Promise<{ deletedCount: number }> {
    const client = new pg.Client({ connectionString: this.dbUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ count: string }>(
        `WITH del AS (
           DELETE FROM unclaimed_folios WHERE ingestion_job_id = $1::uuid RETURNING 1
         ) SELECT count(*)::text AS count FROM del`,
        [batchRunId],
      );
      await client.query(
        `UPDATE ingestion_jobs SET status = 'FAILED', errors = '[{"message": "ROLLED_BACK"}]'::jsonb, total_rows = 0, inserted_rows = 0, finished_at = now() WHERE id = $1::uuid`,
        [batchRunId],
      );
      await client.query("COMMIT");
      const deletedCount = parseInt(res.rows[0]?.count ?? "0", 10);
      return { deletedCount };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
  }
}
