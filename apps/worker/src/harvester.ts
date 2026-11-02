import pg from "pg";

import {
  createPrismaClient,
  enqueueDiscovery,
  harvestFile,
  keysFromEnv,
  LOCAL_DATABASE_URL,
  PriorityIssuersAdapter,
  readManifest,
  RegistrarAdapter,
  rollbackBatch,
  type FileHarvestResult,
  type HarvestTarget,
  type SourceAdapter,
} from "@finsol/db";

export type AdapterId = "kfintech" | "link_intime" | "priority";

export interface DiscoverOptions {
  adapters: AdapterId[];
  limit?: number;
  query?: string;
  /** Queue discovery jobs for the acquisition worker; without it, only list the targets. */
  enqueue?: boolean;
}

/**
 * Pan-India harvester. Two real sources, nothing generated:
 *  - `files()`: statements in the drop folder, listed in its manifest.json with
 *    the company and the URL each file was downloaded from; streamed in chunks.
 *  - `discover()`: issuers selected by registrar or priority from the source
 *    register, queued for the acquisition worker, which finds and fetches the
 *    statements each issuer publishes on its own website.
 */
export class PanIndiaHarvester {
  readonly databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
  private readonly db = createPrismaClient(this.databaseUrl);
  private readonly pool = new pg.Pool({ connectionString: this.databaseUrl, max: 2 });

  adapter(id: AdapterId): SourceAdapter {
    if (id === "kfintech") return new RegistrarAdapter(this.pool, "KFINTECH");
    if (id === "link_intime") return new RegistrarAdapter(this.pool, "LINK_INTIME");
    return new PriorityIssuersAdapter(this.pool);
  }

  async discover(
    opts: DiscoverOptions,
  ): Promise<{ adapter: string; targets: HarvestTarget[]; queued: number }[]> {
    const out = [];
    for (const id of opts.adapters) {
      const a = this.adapter(id);
      const targets = await a.targets({ limit: opts.limit, query: opts.query });
      let queued = 0;
      if (opts.enqueue)
        queued = await enqueueDiscovery(
          this.pool,
          targets.map((t) => t.registerId),
        );
      out.push({ adapter: a.displayName, targets, queued });
    }
    return out;
  }

  async files(
    dir: string,
    opts: { dryRun?: boolean; chunkSize?: number; only?: string[] } = {},
    onChunk?: (
      file: string,
      info: { chunk: number; rowsRead: number; rssMb: number; heapMb: number },
    ) => void,
  ): Promise<FileHarvestResult[]> {
    const keys = keysFromEnv();
    const entries = (await readManifest(dir)).filter(
      (e) => !opts.only?.length || opts.only.includes(e.file),
    );
    const results: FileHarvestResult[] = [];
    for (const e of entries)
      results.push(
        await harvestFile(this.db, keys, dir, e, {
          dryRun: opts.dryRun,
          chunkSize: opts.chunkSize,
          databaseUrl: this.databaseUrl,
          onChunk,
        }),
      );
    return results;
  }

  rollback(batchRunId: string) {
    return rollbackBatch(batchRunId, this.databaseUrl);
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
    await this.pool.end();
  }
}
