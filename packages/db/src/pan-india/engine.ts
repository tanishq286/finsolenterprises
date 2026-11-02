import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { companySlug } from "@finsol/shared";
import pg from "pg";

import { enqueue } from "../acquisition/worker.js";
import type { FieldKeys } from "../crypto.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ingestStatement } from "../ingest-iepf.js";
import { LOCAL_DATABASE_URL } from "../local-url.js";
import { formatOf } from "../statement-reader.js";
import { ingestStatementStream } from "../stream-ingest.js";
import type {
  FileHarvestResult,
  HarvestTarget,
  ManifestEntry,
  RegistrarKey,
  SourceAdapter,
} from "./types.js";

/* ── Adapters: issuer selection from the source register ─────────────────── */

/**
 * How each registrar's name appears in issuer disclosures, including former
 * names (Karvy Fintech became KFin Technologies; Link Intime India became
 * MUFG Intime India; TSR Consultants merged into Link Intime).
 */
export const REGISTRAR_PATTERNS: Record<RegistrarKey, RegExp> = {
  KFINTECH: /\b(kfin|k fin|karvy)\b/i,
  LINK_INTIME: /\b(link\s*intime|mufg\s*intime|tsr\s*(consultants|darashaw))\b/i,
};

interface RegisterRow {
  id: string;
  name: string;
  nse_symbol: string | null;
  isin: string | null;
  registrar: string | null;
  website: string | null;
  ir_url: string | null;
  company_id: string | null;
}

const toTarget = (r: RegisterRow): HarvestTarget => ({
  registerId: r.id,
  name: r.name,
  nseSymbol: r.nse_symbol,
  isin: r.isin,
  registrar: r.registrar,
  website: r.website,
  irUrl: r.ir_url,
  companyId: r.company_id,
});

async function registerRows(
  pool: pg.Pool,
  where: string,
  params: unknown[],
  options?: { limit?: number; query?: string },
): Promise<HarvestTarget[]> {
  const q = options?.query?.trim();
  const args = [...params];
  let sql = `SELECT id, name, nse_symbol, isin, registrar, website, ir_url, company_id
               FROM source_register WHERE (${where})`;
  if (q) {
    args.push(`%${q}%`);
    sql += ` AND (name ILIKE $${args.length} OR nse_symbol ILIKE $${args.length} OR isin ILIKE $${args.length})`;
  }
  sql += " ORDER BY name";
  if (options?.limit) {
    args.push(options.limit);
    sql += ` LIMIT $${args.length}`;
  }
  const { rows } = await pool.query<RegisterRow>(sql, args);
  return rows.map(toTarget);
}

/**
 * Issuers whose registrar is KFin Technologies or MUFG Intime, as recorded
 * in the source register (from the issuer's own disclosures). The
 * registrar's investor portal is a per-holder CAPTCHA lookup and is never
 * queried; the statements come from each issuer's own website.
 */
export class RegistrarAdapter implements SourceAdapter {
  readonly id: string;
  readonly displayName: string;
  constructor(
    private readonly pool: pg.Pool,
    readonly registrar: RegistrarKey,
  ) {
    this.id = registrar === "KFINTECH" ? "kfintech" : "link_intime";
    this.displayName =
      registrar === "KFINTECH"
        ? "Issuers registered with KFin Technologies"
        : "Issuers registered with MUFG Intime (Link Intime)";
  }
  targets(options?: { limit?: number; query?: string }) {
    // Postgres regular expressions spell a word boundary \y; \b there means backspace.
    const pattern = REGISTRAR_PATTERNS[this.registrar].source.replace(/\\b/g, "\\y");
    return registerRows(this.pool, "registrar ~* $1", [pattern], options);
  }
}

/**
 * Large listed issuers to harvest first. This is a priority order by
 * market presence, chosen by Finsol, not a ranking by unclaimed amounts:
 * no public source states unclaimed dividend volumes across companies.
 */
export const PRIORITY_NSE_SYMBOLS = [
  "RELIANCE",
  "ITC",
  "TATAMOTORS",
  "ASIANPAINT",
  "LT",
  "HINDUNILVR",
  "INFY",
  "TCS",
  "HDFCBANK",
  "ICICIBANK",
  "SBIN",
  "BHARTIARTL",
  "KOTAKBANK",
  "AXISBANK",
  "BAJFINANCE",
  "MARUTI",
  "SUNPHARMA",
  "TITAN",
  "ULTRACEMCO",
  "NESTLEIND",
  "WIPRO",
  "HCLTECH",
  "ONGC",
  "NTPC",
  "POWERGRID",
  "TATASTEEL",
  "JSWSTEEL",
  "COALINDIA",
  "BPCL",
  "IOC",
  "HINDALCO",
  "GRASIM",
  "DRREDDY",
  "CIPLA",
  "EICHERMOT",
  "HEROMOTOCO",
  "BAJAJ-AUTO",
  "M&M",
  "BRITANNIA",
  "DABUR",
  "MARICO",
  "GODREJCP",
  "COLPAL",
  "PIDILITIND",
  "HAVELLS",
  "SIEMENS",
  "ABB",
  "BOSCHLTD",
  "SHREECEM",
  "ACC",
  "AMBUJACEM",
  "GAIL",
  "HINDPETRO",
  "BHEL",
  "VEDL",
  "TECHM",
  "LUPIN",
  "TORNTPHARM",
  "DIVISLAB",
  "APOLLOHOSP",
  "INDUSINDBK",
  "BANKBARODA",
  "PNB",
  "CANBK",
  "UNIONBANK",
  "IDFCFIRSTB",
  "TATAPOWER",
  "TATACHEM",
  "TATACONSUM",
  "VOLTAS",
  "MRF",
  "APOLLOTYRE",
  "CEATLTD",
  "ASHOKLEY",
  "TVSMOTOR",
  "BAJAJFINSV",
  "SBILIFE",
  "HDFCLIFE",
  "ICICIPRULI",
  "ADANIENT",
  "ADANIPORTS",
  "BERGEPAINT",
  "KANSAINER",
  "UPL",
  "DLF",
  "GODREJIND",
  "INDHOTEL",
  "JINDALSTEL",
  "SAIL",
  "NMDC",
  "ENGINERSIN",
  "BEL",
  "HAL",
  "CUMMINSIND",
  "THERMAX",
  "CROMPTON",
  "EXIDEIND",
  "ZEEL",
  "SUNTV",
  "MPHASIS",
  "PERSISTENT",
] as const;

export class PriorityIssuersAdapter implements SourceAdapter {
  readonly id = "priority";
  readonly displayName = "Priority large-cap issuers (by market presence)";
  constructor(private readonly pool: pg.Pool) {}
  async targets(options?: { limit?: number; query?: string }) {
    const rows = await registerRows(this.pool, "nse_symbol = ANY($1)", [PRIORITY_NSE_SYMBOLS], {
      query: options?.query,
    });
    const order = new Map(PRIORITY_NSE_SYMBOLS.map((s, i) => [s as string, i]));
    rows.sort(
      (a, b) => (order.get(a.nseSymbol ?? "") ?? 1e9) - (order.get(b.nseSymbol ?? "") ?? 1e9),
    );
    return options?.limit ? rows.slice(0, options.limit) : rows;
  }
}

/** Queues DISCOVER jobs for the acquisition worker (idempotent while a job is queued). */
export async function enqueueDiscovery(pool: pg.Pool, registerIds: string[]): Promise<number> {
  for (const id of registerIds) await enqueue(pool, "DISCOVER", id);
  return registerIds.length;
}

/* ── Drop folder: files a person downloaded, with their provenance ───────── */

export const MANIFEST_FILE = "manifest.json";

export async function readManifest(dir: string): Promise<ManifestEntry[]> {
  const raw = JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { files?: unknown }).files;
  if (!Array.isArray(list)) throw new Error(`${MANIFEST_FILE} must be an array of file entries.`);
  return list.map((e, i) => {
    const m = e as Partial<ManifestEntry>;
    for (const k of ["file", "company", "sourceUrl", "retrievedAt"] as const)
      if (!m[k] || typeof m[k] !== "string")
        throw new Error(`${MANIFEST_FILE} entry ${i + 1}: "${k}" is required.`);
    if (!/^https?:\/\//.test(m.sourceUrl!))
      throw new Error(
        `${MANIFEST_FILE} entry ${i + 1}: sourceUrl must be the http(s) address it came from.`,
      );
    if (Number.isNaN(Date.parse(m.retrievedAt!)))
      throw new Error(`${MANIFEST_FILE} entry ${i + 1}: retrievedAt must be a date.`);
    if (basename(m.file!) !== m.file)
      throw new Error(`${MANIFEST_FILE} entry ${i + 1}: file must be a plain file name.`);
    return m as ManifestEntry;
  });
}

/**
 * The catalogue company for an NSE symbol, ISIN or CIN. A listed company not
 * yet in the catalogue is added from NSE's own equity list (name, ISIN,
 * symbol only); registrar and nodal contacts stay empty until a person
 * verifies them, as the acquisition worker does.
 */
export async function companyFor(
  db: PrismaClient,
  ref: string,
  opts: { create?: boolean } = {},
): Promise<string | null> {
  const key = ref.trim().toUpperCase();
  const found = await db.company.findFirst({
    where: { OR: [{ tickerNse: key }, { isin: key }, { legacyIsins: { has: key } }, { cin: key }] },
    select: { id: true },
  });
  if (found) return found.id;
  const eq = await db.listedEquity.findFirst({
    where: { exchange: "NSE", OR: [{ symbol: key }, { isin: key }] },
  });
  if (!eq) return null;
  if (opts.create === false)
    return `00000000-0000-4000-8000-${createHash("sha256").update(eq.symbol).digest("hex").slice(0, 12)}`;
  if (eq.isin) {
    const byIsin = await db.company.findFirst({ where: { isin: eq.isin }, select: { id: true } });
    if (byIsin) return byIsin.id;
  }
  let slug = companySlug(eq.name);
  if (await db.company.findUnique({ where: { slug }, select: { id: true } }))
    slug = `${slug}-${(eq.isin ?? eq.symbol).toLowerCase().slice(-6)}`;
  const created = await db.company.create({
    data: {
      name: eq.name,
      slug,
      isin: eq.isin,
      tickerNse: eq.symbol,
      statutoryBasis: `Listed company on NSE (${eq.symbol}); statutory filing under Companies Act, 2013`,
      nodalOfficerName: "",
      contactsSource: "NSE equity list; contacts not yet verified",
    },
    select: { id: true },
  });
  return created.id;
}

export interface HarvestOptions {
  dryRun?: boolean;
  chunkSize?: number;
  databaseUrl?: string;
  onChunk?: (
    file: string,
    info: { chunk: number; rowsRead: number; rssMb: number; heapMb: number },
  ) => void;
}

/**
 * Imports one drop-folder file. Spreadsheets and CSVs stream in chunks;
 * PDFs (bounded in size, read by the PDF table reader) go through
 * `ingestStatement`. Each file is its own batch: an ingestion job whose id
 * is stamped on every holder record it writes.
 */
export async function harvestFile(
  db: PrismaClient,
  keys: FieldKeys,
  dir: string,
  entry: ManifestEntry,
  opts: HarvestOptions = {},
): Promise<FileHarvestResult> {
  const path = join(dir, entry.file);
  const { size } = await stat(path);
  const empty: FileHarvestResult = {
    file: entry.file,
    company: entry.company,
    companyId: null,
    batchRunId: null,
    status: "FAILED",
    bytes: size,
    totalRows: 0,
    validRows: 0,
    warningRows: 0,
    quarantinedRows: 0,
    insertedRows: 0,
    updatedRows: 0,
    amountTotal: 0,
    chunks: 0,
    peakRssMb: 0,
    peakHeapMb: 0,
    durationMs: 0,
  };
  const format = formatOf(entry.file) ?? (/\.xlsm$/i.test(entry.file) ? "xlsx" : null);
  if (!format)
    return {
      ...empty,
      status: "UNSUPPORTED",
      detail: "Not a .xlsx, .xlsm, .xls, .csv or .pdf file.",
    };
  // A dry run writes nothing, so a listed company not yet in the catalogue is
  // resolved to a placeholder instead of being created.
  const companyId = opts.dryRun
    ? await companyFor(db, entry.company, { create: false })
    : await companyFor(db, entry.company);
  if (!companyId)
    return { ...empty, detail: `No catalogue company or NSE listing for ${entry.company}.` };

  const source = {
    url: entry.sourceUrl,
    retrievedAt: new Date(entry.retrievedAt),
    reportingPeriod: entry.reportingPeriod ?? null,
  };
  const jobId = opts.dryRun ? null : randomUUID();
  if (jobId)
    await db.ingestionJob.create({
      data: {
        id: jobId,
        formType: entry.shareBasis ? "IEPF_4" : "IEPF_2",
        fileName: entry.file,
        storageKey: `pan-india-drop:${entry.file}`,
        status: "PROCESSING",
        companyId,
        sourceUrl: entry.sourceUrl,
        startedAt: new Date(),
      },
    });
  const started = performance.now();
  try {
    let r;
    if (format === "pdf") {
      const buffer = await readFile(path);
      const res = await ingestStatement(
        db,
        keys,
        { buffer, fileName: entry.file, contentType: "application/pdf" },
        {
          companyId,
          jobId,
          dryRun: opts.dryRun,
          databaseUrl: opts.databaseUrl,
          source,
          shareBasis: entry.shareBasis,
        },
      );
      const m = process.memoryUsage();
      r = {
        ...res,
        alreadyImported: false,
        chunks: 1,
        peakRssMb: Math.round(m.rss / 1048576),
        peakHeapMb: Math.round(m.heapUsed / 1048576),
      };
    } else {
      r = await ingestStatementStream(db, keys, path, {
        companyId,
        jobId,
        dryRun: opts.dryRun,
        databaseUrl: opts.databaseUrl,
        source,
        shareBasis: entry.shareBasis,
        chunkSize: opts.chunkSize,
        onChunk: (info) => opts.onChunk?.(entry.file, info),
      });
    }
    const result: FileHarvestResult = {
      ...empty,
      companyId,
      batchRunId: jobId,
      status: opts.dryRun ? "DRY_RUN" : r.alreadyImported ? "ALREADY_IMPORTED" : "IMPORTED",
      totalRows: r.totalRows,
      validRows: r.validRows,
      warningRows: r.warningRows,
      quarantinedRows: r.quarantinedRows,
      insertedRows: r.insertedRows,
      updatedRows: r.updatedRows,
      amountTotal: r.totals?.amount ?? 0,
      chunks: r.chunks,
      peakRssMb: r.peakRssMb,
      peakHeapMb: r.peakHeapMb,
      durationMs: Math.round(performance.now() - started),
    };
    if (jobId)
      await db.ingestionJob.update({
        where: { id: jobId },
        data: {
          status: "COMPLETED",
          totalRows: r.totalRows,
          insertedRows: r.insertedRows,
          updatedRows: r.updatedRows,
          skippedRows: r.skippedRows,
          warningRows: r.warningRows,
          quarantinedRows: r.quarantinedRows,
          sourceDocumentId: r.sourceDocumentId,
          parserVersion: r.parserVersion,
          errors: r.errors,
          finishedAt: new Date(),
        },
      });
    return result;
  } catch (e) {
    const message = (e as Error).message;
    if (jobId)
      await db.ingestionJob
        .update({
          where: { id: jobId },
          data: { status: "FAILED", errors: [{ message }], finishedAt: new Date() },
        })
        .catch(() => {});
    return {
      ...empty,
      companyId,
      batchRunId: jobId,
      detail: message,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

/**
 * Rolls back one batch. Holder records the batch created are deleted.
 * Records that existed before the batch and also received its lines are
 * NOT deleted (that would destroy older data); they are counted and left
 * for staff review. The batch's source document is marked withdrawn.
 */
export async function rollbackBatch(
  batchRunId: string,
  databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
): Promise<{ deleted: number; keptForReview: number; dividendEventsRemoved: number }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query<{ started_at: Date | null }>(
      `SELECT started_at FROM ingestion_jobs WHERE id = $1::uuid FOR UPDATE`,
      [batchRunId],
    );
    if (!job.rows[0]) throw new Error(`No batch ${batchRunId}.`);
    const { started_at } = job.rows[0];
    const docs = (
      await client.query<{ id: string }>(
        `SELECT id FROM source_documents WHERE ingestion_job_id = $1::uuid
         UNION SELECT source_document_id FROM ingestion_jobs WHERE id = $1::uuid AND source_document_id IS NOT NULL`,
        [batchRunId],
      )
    ).rows.map((r) => r.id);
    const del = await client.query(
      `DELETE FROM unclaimed_folios
        WHERE ingestion_job_id = $1::uuid AND created_at >= $2
          AND NOT EXISTS (SELECT 1 FROM recovery_cases c WHERE c.folio_id = unclaimed_folios.id)`,
      [batchRunId, started_at ?? new Date(0)],
    );
    const kept = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM unclaimed_folios WHERE ingestion_job_id = $1::uuid`,
      [batchRunId],
    );
    let events = 0;
    for (const doc of docs) {
      events +=
        (
          await client.query(
            `DELETE FROM holder_dividend_events WHERE source_document_ids = ARRAY[$1::uuid]`,
            [doc],
          )
        ).rowCount ?? 0;
      await client.query(
        `UPDATE holder_dividend_events SET source_document_ids = array_remove(source_document_ids, $1::uuid)
          WHERE $1::uuid = ANY (source_document_ids)`,
        [doc],
      );
      await client.query(
        `UPDATE source_documents SET publication_status = 'WITHDRAWN', status_detail = 'Batch rolled back'
          WHERE id = $1::uuid`,
        [doc],
      );
    }
    await client.query(
      `UPDATE ingestion_jobs SET status = 'FAILED',
              errors = jsonb_build_array(jsonb_build_object('message', 'ROLLED_BACK', 'keptForReview', $2::int)),
              finished_at = now()
        WHERE id = $1::uuid`,
      [batchRunId, Number(kept.rows[0]?.n ?? 0)],
    );
    await client.query("COMMIT");
    return {
      deleted: del.rowCount ?? 0,
      keptForReview: Number(kept.rows[0]?.n ?? 0),
      dividendEventsRemoved: events,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}
