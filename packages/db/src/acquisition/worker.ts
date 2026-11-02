/**
 * Durable acquisition pipeline, all state in Postgres so it survives restarts
 * and runs on any host (no in-memory timers, no single web request):
 *
 *   source_register ── DISCOVER ──> register_documents ── FETCH ──> file + checksum
 *                                                       └─ PARSE ──> source_documents / source_rows
 *                                                                    unclaimed_folios (staging)
 *                                                                    holder_dividend_events
 *                                                                    shareholding_snapshots
 *
 * Jobs are claimed with FOR UPDATE SKIP LOCKED, retried with backoff and
 * parked as DEAD after max_attempts. Every step records its outcome on the
 * register or document row, so a run can be resumed or audited.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { companySlug } from "@finsol/shared";
import pg from "pg";

import type { FieldKeys } from "../crypto.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ingestStatement, mapHeaders } from "../ingest-iepf.js";
import { formatOf, PARSER_VERSION, readStatement } from "../statement-reader.js";
import {
  classifyDocument,
  safeDecode,
  HOLDER_CLASSES,
  snapshotBasis,
  type DocClass,
} from "./classify.js";
import { crawlIssuer } from "./crawl.js";
import { politeGet } from "./http.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const FILE_DIR = process.env.ACQUIRE_FILE_DIR ?? join(ROOT, ".data", "acquisition", "files");

const DAY = 86_400_000;
export type JobKind = "DISCOVER" | "FETCH" | "PARSE";

export interface Ctx {
  db: PrismaClient;
  pool: pg.Pool;
  keys: FieldKeys;
  databaseUrl: string;
  log: (msg: string) => void;
}

/* ── Queue ──────────────────────────────────────────────────────────────── */

export async function enqueue(pool: pg.Pool, kind: JobKind, targetId: string, delayMs = 0) {
  await pool.query(
    `INSERT INTO acquisition_jobs (kind, target_id, run_after)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (kind, target_id) WHERE status IN ('QUEUED','RUNNING') DO NOTHING`,
    [kind, targetId, String(delayMs)],
  );
}

interface Job {
  id: string;
  kind: JobKind;
  target_id: string;
  attempts: number;
  max_attempts: number;
}

async function claim(pool: pg.Pool, worker: string, kinds: JobKind[]): Promise<Job | null> {
  await pool.query(`UPDATE acquisition_jobs SET status = 'DEAD', finished_at = now(), locked_by = NULL, locked_until = NULL,
    last_error = COALESCE(last_error, 'Lease expired after maximum attempts; manual review required')
    WHERE status = 'RUNNING' AND locked_until < now() AND attempts >= max_attempts`);
  const { rows } = await pool.query<Job>(
    `UPDATE acquisition_jobs SET status = 'RUNNING', locked_by = $1,
            locked_until = now() + interval '10 minutes', attempts = attempts + 1
      WHERE id = (SELECT id FROM acquisition_jobs
                   WHERE (status = 'QUEUED' OR (status = 'RUNNING' AND locked_until < now()))
                     AND run_after <= now() AND attempts < max_attempts AND kind = ANY($2)
                   ORDER BY CASE kind WHEN 'PARSE' THEN 0 WHEN 'FETCH' THEN 1 ELSE 2 END, run_after
                   LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, target_id, attempts, max_attempts`,
    [worker, kinds],
  );
  return rows[0] ?? null;
}

async function finish(pool: pg.Pool, job: Job, worker: string, error?: string, retryable = true) {
  if (!error) {
    await pool.query(
      `UPDATE acquisition_jobs SET status = 'DONE', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE id = $1 AND locked_by = $2`,
      [job.id, worker],
    );
    return;
  }
  const dead = !retryable || job.attempts >= job.max_attempts;
  await pool.query(
    `UPDATE acquisition_jobs SET status = $2, last_error = $3, locked_by = NULL, locked_until = NULL,
            run_after = now() + ($4 || ' minutes')::interval, finished_at = CASE WHEN $2 = 'DEAD' THEN now() END
      WHERE id = $1 AND locked_by = $5`,
    [job.id, dead ? "DEAD" : "QUEUED", error.slice(0, 500), String(2 ** job.attempts), worker],
  );
}

/** Runs jobs until none are ready or the deadline passes. `concurrency` loops share the queue. */
export async function work(
  ctx: Ctx,
  opts: { concurrency: number; deadline: number; kinds?: JobKind[] },
): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  const kinds = opts.kinds ?? ["DISCOVER", "FETCH", "PARSE"];
  const loop = async (n: number) => {
    const worker = `w${n}-${randomUUID().slice(0, 8)}`;
    while (Date.now() < opts.deadline) {
      const job = await claim(ctx.pool, worker, kinds);
      if (!job) break;
      const heartbeat = setInterval(() => {
        void ctx.pool
          .query(
            `UPDATE acquisition_jobs SET locked_until = now() + interval '10 minutes'
          WHERE id = $1 AND status = 'RUNNING' AND locked_by = $2`,
            [job.id, worker],
          )
          .catch(() => ctx.log(`Lease renewal failed for ${job.id}; retrying at next heartbeat`));
      }, 30_000);
      try {
        const outcome = await HANDLERS[job.kind](ctx, job.target_id);
        stats[`${job.kind}:${outcome}`] = (stats[`${job.kind}:${outcome}`] ?? 0) + 1;
        await finish(ctx.pool, job, worker);
      } catch (e) {
        const err = e as Error & { retryable?: boolean };
        stats[`${job.kind}:error`] = (stats[`${job.kind}:error`] ?? 0) + 1;
        ctx.log(`${job.kind} ${job.target_id}: ${err.message.slice(0, 160)}`);
        await finish(ctx.pool, job, worker, err.message, err.retryable !== false);
      } finally {
        clearInterval(heartbeat);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, (_, i) => loop(i)));
  return stats;
}

/* ── Handlers ───────────────────────────────────────────────────────────── */

const HANDLERS: Record<JobKind, (ctx: Ctx, id: string) => Promise<string>> = {
  DISCOVER: discover,
  FETCH: fetchDocument,
  PARSE: parseDocument,
};

const BULK_FOR: Record<string, string> = {
  OK: "AVAILABLE",
  SCRIPT_RENDERED: "UNCERTAIN",
  NO_DOCUMENTS: "NOT_FOUND",
  ROBOTS_DISALLOWED: "RESTRICTED",
  BLOCKED_403: "RESTRICTED",
  HTTP_ERROR: "UNCERTAIN",
  TIMEOUT: "UNCERTAIN",
  ERROR: "UNCERTAIN",
};

async function discover(ctx: Ctx, registerId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ website: string | null; ir_url: string | null }>(
    `SELECT website, ir_url FROM source_register WHERE id = $1`,
    [registerId],
  );
  const r = rows[0];
  if (!r) return "missing";
  const start = r.ir_url ?? r.website;
  if (!start) {
    await ctx.pool.query(
      `UPDATE source_register SET last_attempt_at = now(), last_result = 'NO_WEBSITE',
              last_result_detail = 'No verified website or investor page on record',
              next_review_at = now() + interval '90 days', updated_at = now() WHERE id = $1`,
      [registerId],
    );
    return "NO_WEBSITE";
  }
  const res = await crawlIssuer(start);
  for (const d of res.documents) {
    const { rows: up } = await ctx.pool.query<{ id: string; status: string }>(
      `INSERT INTO register_documents (register_id, url, label, found_on, doc_class, period_hint)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (register_id, url) DO UPDATE SET last_seen_at = now(),
         label = COALESCE(NULLIF(EXCLUDED.label, ''), register_documents.label)
       RETURNING id, status`,
      [registerId, d.url, d.label, d.foundOn, d.docClass, d.periodHint],
    );
    if ((HOLDER_CLASSES as string[]).includes(d.docClass))
      await enqueue(ctx.pool, "FETCH", up[0]!.id);
  }
  await ctx.pool.query(
    `UPDATE source_register SET last_attempt_at = now(), last_result = $2, last_result_detail = $3,
            ir_url = COALESCE(ir_url, $4), ir_url_basis = COALESCE(ir_url_basis, CASE WHEN $4::text IS NOT NULL THEN 'crawl from ' || $5 END),
            bulk_access = $6,
            access_method = CASE WHEN $2 = 'OK' THEN 'PUBLIC_STATUTORY_DISCLOSURE' ELSE access_method END,
            permitted_use_note = CASE WHEN $2 = 'OK' THEN
              'Document links located on a candidate issuer site. Official-domain evidence and permitted reuse require review before release.'
              ELSE permitted_use_note END,
            documents_found = (SELECT count(*) FROM register_documents WHERE register_id = $1),
            next_review_at = now() + ($7 || ' days')::interval, updated_at = now()
      WHERE id = $1`,
    [
      registerId,
      res.result,
      res.detail,
      res.irUrl,
      start,
      BULK_FOR[res.result] ?? "UNCERTAIN",
      res.result === "OK" ? "30" : "90",
    ],
  );
  return res.result;
}

const EXT: Record<string, string> = { pdf: "pdf", xlsx: "xlsx", xls: "xls", csv: "csv" };

async function fetchDocument(ctx: Ctx, docId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{
    url: string;
    sha256: string | null;
    http_etag: string | null;
    http_last_modified: string | null;
    status: string;
  }>(
    `SELECT url, sha256, http_etag, http_last_modified, status FROM register_documents WHERE id = $1`,
    [docId],
  );
  const d = rows[0];
  if (!d) return "missing";
  const res = await politeGet(d.url, {
    etag: d.http_etag,
    lastModified: d.http_last_modified,
    timeoutMs: 90_000,
  });
  const mark = (status: string, detail: string | null) =>
    ctx.pool.query(
      `UPDATE register_documents SET status = $2, status_detail = $3, fetch_attempts = fetch_attempts + 1 WHERE id = $1`,
      [docId, status, detail],
    );
  if (res.kind === "not-modified") {
    await ctx.pool.query(`UPDATE register_documents SET last_seen_at = now() WHERE id = $1`, [
      docId,
    ]);
    if (d.sha256 && ["DOWNLOADED", "PARSE_FAILED"].includes(d.status))
      await enqueue(ctx.pool, "PARSE", docId);
    return "not-modified";
  }
  if (res.kind === "robots" || res.kind === "blocked" || res.kind === "too-large") {
    await mark(
      "FETCH_FAILED",
      res.kind === "blocked" ? `Access refused (HTTP ${res.status}); not bypassed` : res.kind,
    );
    return res.kind;
  }
  if (res.kind !== "ok") {
    await mark("FETCH_FAILED", res.kind === "http-error" ? `HTTP ${res.status}` : res.message);
    if (res.kind === "http-error" && res.status === 404) return "not-found";
    throw Object.assign(new Error(res.kind === "http-error" ? `HTTP ${res.status}` : res.message), {
      retryable: true,
    });
  }
  const sha = createHash("sha256").update(res.body).digest("hex");
  if (sha === d.sha256) {
    await ctx.pool.query(
      `UPDATE register_documents SET last_seen_at = now(), fetched_at = now() WHERE id = $1`,
      [docId],
    );
    if (["DOWNLOADED", "PARSE_FAILED"].includes(d.status)) await enqueue(ctx.pool, "PARSE", docId);
    return "unchanged";
  }
  const format =
    formatOf(new URL(res.finalUrl).pathname, res.contentType) ?? formatOf(d.url, res.contentType);
  const path = join(FILE_DIR, `${sha}.${format ? EXT[format] : "bin"}`);
  await mkdir(FILE_DIR, { recursive: true });
  await writeFile(path, res.body);
  await ctx.pool.query(
    `UPDATE register_documents SET status = 'DOWNLOADED', status_detail = NULL, sha256 = $2,
            previous_sha256 = CASE WHEN sha256 IS NOT NULL AND sha256 <> $2 THEN sha256 ELSE previous_sha256 END,
            bytes = $3, content_type = $4, storage_path = $5, http_etag = $6, http_last_modified = $7,
            fetched_at = now(), last_seen_at = now(), fetch_attempts = fetch_attempts + 1
      WHERE id = $1`,
    [docId, sha, res.body.length, res.contentType, path, res.etag, res.lastModified],
  );
  await enqueue(ctx.pool, "PARSE", docId);
  return d.sha256 ? "changed" : "downloaded";
}

/** True when a PDF has (almost) no text layer: a scan that would need OCR. */
async function pdfNeedsOcr(buffer: Buffer): Promise<boolean> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0 });
    const doc = await task.promise;
    let chars = 0;
    for (let p = 1; p <= Math.min(3, doc.numPages); p++) {
      const c = await (await doc.getPage(p)).getTextContent();
      chars += (c.items as { str?: string }[]).reduce((n, i) => n + (i.str?.trim().length ?? 0), 0);
    }
    await task.destroy();
    return chars < 40;
  } catch {
    return false;
  }
}

async function ensureCompany(ctx: Ctx, registerId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{
    company_id: string | null;
    name: string;
    isin: string | null;
    nse_symbol: string | null;
    ir_url: string | null;
    cin: string | null;
  }>(`SELECT company_id, name, isin, nse_symbol, ir_url, cin FROM source_register WHERE id = $1`, [
    registerId,
  ]);
  const r = rows[0]!;
  if (r.company_id) return r.company_id;
  const existing = await ctx.db.company.findFirst({
    where: {
      OR: [
        ...(r.isin ? [{ isin: r.isin }, { legacyIsins: { has: r.isin } }] : []),
        ...(r.nse_symbol ? [{ tickerNse: r.nse_symbol }] : []),
        ...(r.cin ? [{ cin: r.cin }] : []),
      ],
    },
    select: { id: true },
  });
  let id = existing?.id;
  if (!id) {
    let slug = companySlug(r.name);
    if (await ctx.db.company.findUnique({ where: { slug }, select: { id: true } }))
      slug = `${slug}-${(r.isin ?? r.nse_symbol ?? randomUUID()).toLowerCase().slice(-6)}`;
    // Only what the register knows; registrar and nodal contacts stay empty until a person checks them.
    try {
      id = (
        await ctx.db.company.create({
          data: {
            name: r.name,
            slug,
            cin: r.cin ?? undefined,
            statutoryBasis: r.cin
              ? null
              : `Listed company on NSE (${r.nse_symbol ?? "equity"}); statutory filing under Companies Act, 2013`,
            isin: r.isin,
            tickerNse: r.nse_symbol,
            nodalOfficerName: "",
            irPageUrl: r.ir_url,
            contactsSource: "Source register; contacts not yet verified",
          },
          select: { id: true },
        })
      ).id;
    } catch (e) {
      const retry = await ctx.db.company.findFirst({
        where: {
          OR: [
            ...(r.isin ? [{ isin: r.isin }, { legacyIsins: { has: r.isin } }] : []),
            ...(r.nse_symbol ? [{ tickerNse: r.nse_symbol }] : []),
            ...(r.cin ? [{ cin: r.cin }] : []),
          ],
        },
        select: { id: true },
      });
      if (retry) id = retry.id;
      else throw e;
    }
  }
  await ctx.pool.query(`UPDATE source_register SET company_id = $2 WHERE id = $1`, [
    registerId,
    id,
  ]);
  return id;
}

async function parseDocument(ctx: Ctx, docId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{
    register_id: string;
    url: string;
    label: string | null;
    found_on: string | null;
    doc_class: DocClass;
    period_hint: string | null;
    storage_path: string | null;
    content_type: string | null;
    fetched_at: Date | null;
    http_last_modified: string | null;
    previous_sha256: string | null;
  }>(
    `SELECT register_id, url, label, found_on, doc_class, period_hint, storage_path, content_type, fetched_at, http_last_modified, previous_sha256
       FROM register_documents WHERE id = $1`,
    [docId],
  );
  const d = rows[0];
  if (!d?.storage_path) return "missing";
  const mark = (status: string, detail: unknown) =>
    ctx.pool.query(`UPDATE register_documents SET status = $2, status_detail = $3 WHERE id = $1`, [
      docId,
      status,
      typeof detail === "string" ? detail : JSON.stringify(detail),
    ]);
  const buffer = await readFile(d.storage_path);
  const fileName = safeDecode(new URL(d.url).pathname.split("/").pop() || "statement");
  const format = formatOf(d.storage_path, d.content_type);
  if (!format) {
    await mark("NOT_HOLDER_DATA", "Not a PDF, Excel or CSV file");
    return "unsupported";
  }
  let headers: string[];
  try {
    headers = (await readStatement(buffer, d.storage_path, d.content_type)).headers;
  } catch {
    if (format === "pdf" && (await pdfNeedsOcr(buffer))) {
      // A scan: OCR would be needed, and its output must be reviewed. No OCR engine is configured.
      await mark("OCR_REQUIRED", "Scanned PDF with no text layer; OCR not configured");
      return "ocr-required";
    }
    await mark("NOT_HOLDER_DATA", "No table with a folio or demat account column");
    return "not-holder-data";
  }
  const { map } = mapHeaders(headers);
  if (map.first === undefined && map.fullName === undefined && map.last === undefined) {
    await mark("NOT_HOLDER_DATA", "No investor name column found");
    return "not-holder-data";
  }
  if (
    map.folio === undefined &&
    map.dematId === undefined &&
    map.shares === undefined &&
    map.amount === undefined
  ) {
    await mark(
      "NOT_HOLDER_DATA",
      "No table with a folio, demat account, shares or dividend column",
    );
    return "not-holder-data";
  }
  const isShareList = map.shares !== undefined;
  let basis = isShareList ? snapshotBasis(d.doc_class) : null;
  if (isShareList && !basis) {
    // Parent pages mix proposed and completed transfers. Generic IEPF text
    // does not establish completed transfer; use document-specific evidence.
    basis = snapshotBasis(
      classifyDocument(d.url, `${d.label ?? ""} ${headers.join(" ")}`).docClass,
    );
  }
  if (isShareList && !basis) {
    await mark(
      "NEEDS_CLASSIFICATION",
      "Share list: proposed or transferred is not clear from the source; held for review",
    );
    return "needs-classification";
  }
  const companyId = await ensureCompany(ctx, d.register_id);
  let r;
  try {
    r = await ingestStatement(
      ctx.db,
      ctx.keys,
      { buffer, fileName, contentType: d.content_type },
      {
        companyId,
        databaseUrl: ctx.databaseUrl,
        ...(basis ? { shareBasis: basis } : {}),
        source: {
          url: d.url,
          retrievedAt: d.fetched_at ?? new Date(),
          publishedAt: d.http_last_modified ? new Date(d.http_last_modified) : null,
          publishedAtBasis: d.http_last_modified ? "HTTP_LAST_MODIFIED" : "UNKNOWN",
          reportingPeriod: d.period_hint,
          documentType: isShareList ? "IEPF_4_STATEMENT" : "IEPF_2_STATEMENT",
        },
      },
    );
  } catch (err) {
    const msg = (err as Error).message || String(err);
    if (/no investor name column/i.test(msg)) {
      await mark("NOT_HOLDER_DATA", msg);
      return "not-holder-data";
    }
    throw err;
  }
  await ctx.pool.query(`UPDATE register_documents SET source_document_id = $2 WHERE id = $1`, [
    docId,
    r.sourceDocumentId,
  ]);
  // Evidence, scoped to this document; never a generic "verified" badge.
  const evidence = `${d.url} sha256:${r.sha256.slice(0, 16)} reader:${PARSER_VERSION}`;
  const states: [string, string][] = [
    [
      "HELD_FOR_REVIEW",
      "Candidate issuer source; automated name matching does not independently establish an official domain or permitted reuse",
    ],
    ["HISTORICAL_LISTING", "Rows describe the position on the statement's own dates"],
    [
      "CURRENT_STATUS_NOT_CONFIRMED",
      "The source gives no claim-status updates; current entitlement unknown",
    ],
  ];
  const accepted = r.validRows + r.warningRows;
  states.push(
    r.quarantinedRows === 0 && accepted > 0
      ? [
          "EXTRACTION_VALIDATED",
          `All ${accepted} rows passed validation (${r.warningRows} with warnings)`,
        ]
      : ["HELD_FOR_REVIEW", `${r.quarantinedRows} of ${r.totalRows} rows quarantined for review`],
  );
  for (const [state, scope] of states)
    await ctx.pool.query(
      `INSERT INTO record_verifications (entity_type, entity_id, state, scope, evidence) VALUES ('SOURCE_DOCUMENT', $1, $2, $3, $4)`,
      [r.sourceDocumentId, state, scope, evidence],
    );
  if (d.previous_sha256) await supersede(ctx, d.previous_sha256, r.sourceDocumentId!);
  await mark("IMPORTED", {
    rows: r.totalRows,
    valid: r.validRows,
    warning: r.warningRows,
    quarantined: r.quarantinedRows,
    inserted: r.insertedRows,
    updated: r.updatedRows,
    events: r.dividendEvents?.written ?? 0,
    snapshots: r.shareSnapshots ?? 0,
    totals: r.totals,
    form: r.form,
    basis,
  });
  return "imported";
}

/**
 * A new version of a document replaces its earlier figures without deleting
 * them: snapshots and amounts from the old version that the new one restates
 * are marked superseded.
 */
async function supersede(ctx: Ctx, oldSha: string, newDocId: string) {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM source_documents WHERE sha256 = $1 AND id <> $2`,
    [oldSha, newDocId],
  );
  for (const old of rows) {
    await ctx.pool.query(
      `UPDATE shareholding_snapshots o SET superseded_by_id = n.id, superseded_at = now()
         FROM shareholding_snapshots n
        WHERE o.source_document_id = $1 AND n.source_document_id = $2 AND o.superseded_by_id IS NULL
          AND (o.company_id, o.folio_number_hash, o.holder_name_norm, o.basis) = (n.company_id, n.folio_number_hash, n.holder_name_norm, n.basis)`,
      [old.id, newDocId],
    );
    await ctx.pool.query(
      `UPDATE holder_dividend_events o SET superseded_by_id = n.id, superseded_at = now()
         FROM holder_dividend_events n
        WHERE o.source_document_ids = ARRAY[$1::uuid] AND $2::uuid = ANY(n.source_document_ids)
          AND o.id <> n.id AND o.superseded_by_id IS NULL
          AND (o.company_id, o.folio_number_hash, o.holder_name_norm, o.event_key) = (n.company_id, n.folio_number_hash, n.holder_name_norm, n.event_key)`,
      [old.id, newDocId],
    );
  }
}
