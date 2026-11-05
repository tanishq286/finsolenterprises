import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  computeEntitlement,
  statusOf,
  type CorporateActionLike,
  type IngestionForm,
  type IssueCode,
} from "@finsol/shared";
import pg from "pg";

import { bulkUpsertFolios, type StagedFolio } from "./bulk-copy.js";
import { folioColumns, folioSearchColumns } from "./columns.js";
import { blindIndex, encryptField, type FieldKeys } from "./crypto.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import {
  detectForm,
  holderNorm,
  mapHeaders,
  parseRow,
  writeDividendEvents,
  writeShareSnapshots,
  type Accepted,
  type IngestOptions,
  type IngestResult,
  type ParsedRow,
} from "./ingest-iepf.js";
import { LOCAL_DATABASE_URL } from "./local-url.js";
import { chunked, openStatementStream, STREAM_PARSER_VERSION } from "./stream-reader.js";

/**
 * Streaming twin of `ingestStatement` for statements too large to hold in
 * memory (multi-gigabyte .xlsx or .csv). Memory stays bounded by the chunk
 * size, not the file:
 *
 *   1. The file is hashed as a stream. A file already imported with this
 *      reader (same SHA-256 and parser version) is skipped, so re-runs are
 *      idempotent at the file level.
 *   2. Rows stream through the same `parseRow` validation as the in-memory
 *      importer, `chunkSize` at a time. Each chunk writes its source rows
 *      (raw cells encrypted), dividend events and share snapshots, and stages
 *      its accepted lines in a session temp table.
 *   3. Postgres groups the staged lines into holders (one per company, folio
 *      and name, summing amounts per dividend event, as `ingestStatement`
 *      does in memory), and a cursor feeds complete holders to the binary
 *      COPY merge in chunks.
 *
 * Every holder record carries `ingestion_job_id` and `source_document_id`,
 * so a batch can be audited or rolled back.
 */
export interface StreamIngestOptions extends Omit<IngestOptions, "plan"> {
  /** Rows per chunk (parse, provenance and merge). Default 5,000. */
  chunkSize?: number;
  /** Called after each chunk with rows read so far and the process's peak RSS in MB. */
  onChunk?: (info: { chunk: number; rowsRead: number; rssMb: number; heapMb: number }) => void;
}

export interface StreamIngestResult extends IngestResult {
  alreadyImported: boolean;
  bytes: number;
  chunks: number;
  peakRssMb: number;
  peakHeapMb: number;
  durationMs: number;
}

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** What one accepted statement line contributes to its holder, staged as JSON. */
interface Line {
  first: string;
  middle: string;
  last: string;
  fatherOrSpouse: string | null;
  fatherOrSpouseRaw: string | null;
  relSuspect: boolean;
  address: string | null;
  city: string | null;
  state: ParsedRow["state"];
  pincode: string | null;
  certificates: string | null;
  eventDate: string | null;
  transferFinancialYear: string | null;
  investmentType: string | null;
  srn: string | null;
  folioNumber: string;
  folioNumberMasked: string;
  folioNumberHash: string;
}

const GROUPED_SQL = `
  SELECT s.group_key, s.company_id, s.shares, s.rids, s.rep, s.latest, s.clean_rel, s.issue_list,
         COALESCE(e.amounts, '{}'::jsonb) AS amounts
    FROM (SELECT group_key,
                 (array_agg(company_id))[1] AS company_id,
                 max(shares) AS shares,
                 array_remove(array_agg(source_row_id ORDER BY row_index), NULL) AS rids,
                 (array_agg(line ORDER BY row_index))[1] AS rep,
                 (array_agg(line ORDER BY event_date DESC NULLS LAST, row_index))[1] AS latest,
                 (array_agg(line ORDER BY row_index)
                    FILTER (WHERE NOT (line->>'relSuspect')::boolean AND line->>'fatherOrSpouse' IS NOT NULL))[1] AS clean_rel,
                 string_agg(array_to_string(issues, ','), ',') AS issue_list
            FROM stage_lines GROUP BY group_key) s
    LEFT JOIN (SELECT group_key, jsonb_object_agg(event_key, a) AS amounts
                 FROM (SELECT group_key, event_key, round(sum(amount), 2) AS a
                         FROM stage_lines WHERE amount > 0 GROUP BY 1, 2) x
                GROUP BY 1) e USING (group_key)
   ORDER BY s.group_key`;

export async function ingestStatementStream(
  db: PrismaClient,
  keys: FieldKeys,
  path: string,
  opts: StreamIngestOptions = {},
): Promise<StreamIngestResult> {
  const started = performance.now();
  const chunkSize = opts.chunkSize ?? 5000;
  const fileName = basename(path);
  const { size: bytes } = await stat(path);
  let peakRss = 0;
  let peakHeap = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
    return { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) };
  };
  sample();

  const sha256 = await sha256File(path);
  const base = {
    sha256,
    parserVersion: STREAM_PARSER_VERSION,
    bytes,
    unmappedHeaders: [] as string[],
    preview: [],
    errors: [] as { row: number; message: string }[],
    issueCounts: {} as Partial<Record<IssueCode, number>>,
  };

  if (opts.source && !opts.dryRun) {
    const prior = await db.sourceDocument.findUnique({
      where: { sha256_parserVersion: { sha256, parserVersion: STREAM_PARSER_VERSION } },
    });
    if (prior?.status === "IMPORTED" && prior.publicationStatus !== "WITHDRAWN")
      return {
        ...base,
        form: (prior.documentType === "IEPF_4_STATEMENT" ? "IEPF_4" : "IEPF_2") as IngestionForm,
        sheet: "",
        sourceDocumentId: prior.id,
        totalRows: prior.rowCount ?? 0,
        insertedRows: 0,
        updatedRows: 0,
        skippedRows: 0,
        quarantinedRecords: 0,
        validRows: prior.validRows ?? 0,
        warningRows: prior.warningRows ?? 0,
        quarantinedRows: prior.quarantinedRows ?? 0,
        alreadyImported: true,
        chunks: 0,
        peakRssMb: Math.round(peakRss / 1048576),
        peakHeapMb: Math.round(peakHeap / 1048576),
        durationMs: Math.round(performance.now() - started),
      };
  }

  const opened = await openStatementStream(path, fileName);
  const { map, unmapped } = mapHeaders(opened.headers);
  if (map.first === undefined && map.fullName === undefined && map.last === undefined)
    throw new Error(
      `No investor name column. Headers found: ${opened.headers.filter(Boolean).join(", ")}`,
    );
  const form = opts.form ?? detectForm(map);
  if (form === "IEPF_4" && opts.source && !opts.shareBasis)
    throw new Error(
      "This is a share list, but whether its shares were transferred or are only due for transfer is not known. Classify the document before importing.",
    );

  // Company resolution, as in ingestStatement.
  const companies = await db.company.findMany({
    select: { id: true, cin: true, name: true, isin: true, legacyIsins: true },
  });
  const byName = new Map<string, string>();
  for (const c of companies) {
    byName.set(norm(c.name), c.id);
    byName.set(norm(c.name.replace(/limited$/i, "ltd")), c.id);
  }
  const byCin = new Map(companies.filter((c) => c.cin).map((c) => [c.cin!, c.id]));
  const byIsin = new Map(
    companies.flatMap((c) => [...(c.isin ? [c.isin] : []), ...c.legacyIsins].map((i) => [i, c.id])),
  );
  const resolve = (r: ParsedRow) =>
    opts.companyId ??
    (r.cin && byCin.get(r.cin)) ??
    (r.isin && byIsin.get(r.isin)) ??
    (r.companyName && byName.get(norm(r.companyName))) ??
    null;

  const errors = base.errors;
  const issueCounts = base.issueCounts;
  const count = (issues: readonly IssueCode[]) => {
    for (const i of issues) issueCounts[i] = (issueCounts[i] ?? 0) + 1;
  };
  const tally = { VALID: 0, WARNING: 0, QUARANTINED: 0 };
  let total = 0;
  let skipped = 0;
  let chunks = 0;
  let rowsRead = 0;
  const totals = { amount: 0, shares: 0 };
  const evTotals = { written: 0, amountTotal: 0 };
  let snapshots = 0;
  const companyIds = new Set<string>();
  const eventKey = (r: ParsedRow) =>
    r.eventDate ? r.eventDate.toISOString().slice(0, 10) : (r.transferFinancialYear ?? "undated");
  const firstDataRow = opened.headerRow + 1;

  const write = !opts.dryRun;
  const client = write
    ? new pg.Client({
        connectionString: opts.databaseUrl ?? process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
      })
    : null;
  let documentId: string | null = null;
  try {
    if (client) {
      await client.connect();
      await client.query(`CREATE TEMP TABLE stage_lines (
        row_index int, company_id uuid, group_key text, event_key text, amount numeric,
        shares int, event_date date, issues text[], source_row_id uuid, line jsonb)`);
      if (opts.source) {
        const doc = await db.sourceDocument.upsert({
          where: { sha256_parserVersion: { sha256, parserVersion: STREAM_PARSER_VERSION } },
          update: {
            status: "RETRIEVED",
            publicationStatus: "UNPUBLISHED",
            ingestionJobId: opts.jobId ?? undefined,
          },
          create: {
            companyId: opts.companyId ?? null,
            sourceUrl: opts.source.url ?? null,
            fileName,
            documentType:
              opts.source.documentType ??
              (form === "IEPF_4" ? "IEPF_4_STATEMENT" : "IEPF_2_STATEMENT"),
            reportingPeriod: opts.source.reportingPeriod ?? null,
            publishedAt: opts.source.publishedAt ?? null,
            publishedAtBasis: opts.source.publishedAtBasis ?? "UNKNOWN",
            retrievedAt: opts.source.retrievedAt,
            sha256,
            bytes,
            contentType: null,
            parserVersion: STREAM_PARSER_VERSION,
            status: "RETRIEVED",
            quantityBasis: form === "IEPF_4" ? "SHARES_AS_STATED_ON_EVENT_DATE" : "AMOUNT_ONLY",
            ingestionJobId: opts.jobId ?? null,
          },
        });
        documentId = doc.id;
      }
    }

    for await (const rows of chunked(opened.rows, chunkSize)) {
      chunks++;
      rowsRead += rows.length;
      const outcomes: {
        index: number;
        number: number;
        cells: unknown[];
        issues: IssueCode[];
        status: "VALID" | "WARNING" | "QUARANTINED";
      }[] = [];
      const accepted: (Accepted & { line: Line; key: string })[] = [];
      for (const { number, cells } of rows) {
        const res = parseRow(cells, map, number, form);
        if (!res) continue;
        total++;
        const index = number - firstDataRow;
        if (!res.ok) {
          skipped++;
          count(res.issues);
          if (errors.length < 50) errors.push({ row: res.row, message: res.message });
          outcomes.push({ index, number, cells, issues: res.issues, status: "QUARANTINED" });
          continue;
        }
        const r = res.value;
        const companyId = resolve(r);
        if (!companyId) {
          skipped++;
          count(["UNREADABLE"]);
          if (errors.length < 50)
            errors.push({
              row: r.row,
              message: `Unknown company ${r.cin ?? r.isin ?? r.companyName ?? ""}`.trim(),
            });
          outcomes.push({ index, number, cells, issues: ["UNREADABLE"], status: "QUARANTINED" });
          continue;
        }
        count(r.issues);
        companyIds.add(companyId);
        outcomes.push({ index, number, cells, issues: r.issues, status: statusOf(r.issues) });
        totals.amount += r.amountRupees;
        totals.shares += r.shares;
        if (!write) continue;
        const folio = folioColumns(r.folio, keys);
        accepted.push({
          index,
          companyId,
          row: r,
          folioHash: folio.folioNumberHash,
          key: `${companyId}|${folio.folioNumberHash}|${holderNorm(r)}`,
          line: {
            first: r.first,
            middle: r.middle,
            last: r.last,
            fatherOrSpouse: r.fatherOrSpouse,
            fatherOrSpouseRaw: r.fatherOrSpouseRaw,
            relSuspect: r.issues.includes("RELATIVE_SUSPECT"),
            address: r.address,
            city: r.city,
            state: r.state,
            pincode: r.pincode,
            certificates: r.certificates,
            eventDate: r.eventDate ? r.eventDate.toISOString() : null,
            transferFinancialYear: r.transferFinancialYear,
            investmentType: r.investmentType,
            srn: r.srn,
            ...folio,
          },
        });
      }
      for (const o of outcomes) tally[o.status]++;

      if (client) {
        // Provenance rows for this chunk (idempotent on (document, row index)).
        const rowIds = new Map<number, string>();
        if (documentId && outcomes.length) {
          // Plain SQL on the dedicated connection: far less garbage per chunk than createMany.
          const existing = await client.query<{ id: string; row_index: number }>(
            `SELECT id, row_index FROM source_rows WHERE source_document_id = $1 AND row_index = ANY ($2::int[])`,
            [documentId, outcomes.map((o) => o.index)],
          );
          for (const e of existing.rows) rowIds.set(e.row_index, e.id);
          const fresh = outcomes.filter((o) => !rowIds.has(o.index));
          if (fresh.length) {
            const ids: string[] = [];
            const enc: string[] = [];
            const hashes: string[] = [];
            for (const o of fresh) {
              const id = crypto.randomUUID();
              rowIds.set(o.index, id);
              ids.push(id);
              const json = JSON.stringify(
                Object.fromEntries(
                  opened.headers.map((h, c) => [h || `column ${c + 1}`, o.cells[c] ?? null]),
                ),
              );
              enc.push(encryptField(json, keys));
              hashes.push(blindIndex(json, keys));
            }
            await client.query(
              `INSERT INTO source_rows (id, source_document_id, row_index, row_ref, raw_cells_enc, raw_hash,
                                        validation_status, issues, review_status)
               SELECT id, $1::uuid, i, ref, e, h, st, COALESCE(string_to_array(NULLIF(iss, ''), ','), '{}'),
                      CASE WHEN st = 'QUARANTINED' THEN 'PENDING_REVIEW' ELSE 'NOT_REQUIRED' END
                 FROM unnest($2::uuid[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
                      AS x(id, i, ref, e, h, st, iss)
               ON CONFLICT DO NOTHING`,
              [
                documentId,
                ids,
                fresh.map((o) => o.index),
                fresh.map((o) => `${opened.sheet}, row ${o.number}`),
                enc,
                hashes,
                fresh.map((o) => o.status),
                fresh.map((o) => o.issues.join(",")),
              ],
            );
          }
          const ev = await writeDividendEvents(db, documentId, accepted, rowIds, eventKey);
          evTotals.written += ev.written;
          evTotals.amountTotal += ev.amountTotal;
          if (opts.shareBasis)
            snapshots += await writeShareSnapshots(
              db,
              documentId,
              accepted,
              rowIds,
              opts.shareBasis,
            );
        }
        if (accepted.length)
          await client.query(
            `INSERT INTO stage_lines
             SELECT i, c, k, e, a, s, d, string_to_array(NULLIF(iss, ''), ','), r, l
               FROM unnest($1::int[], $2::uuid[], $3::text[], $4::text[], $5::numeric[], $6::int[],
                           $7::date[], $8::text[], $9::uuid[], $10::jsonb[])
                    AS x(i, c, k, e, a, s, d, iss, r, l)`,
            [
              accepted.map((a) => a.index),
              accepted.map((a) => a.companyId),
              accepted.map((a) => a.key),
              accepted.map((a) => eventKey(a.row)),
              accepted.map((a) => a.row.amountRupees.toFixed(2)),
              accepted.map((a) => a.row.shares),
              accepted.map((a) => a.row.eventDate?.toISOString().slice(0, 10) ?? null),
              accepted.map((a) => a.row.issues.join(",")),
              accepted.map((a) => rowIds.get(a.index) ?? null),
              accepted.map((a) => JSON.stringify(a.line)),
            ],
          );
      }
      opts.onChunk?.({ chunk: chunks, rowsRead, ...sample() });
    }

    const result: StreamIngestResult = {
      ...base,
      unmappedHeaders: unmapped,
      form,
      sheet: opened.sheet,
      sourceDocumentId: documentId,
      totalRows: total,
      insertedRows: 0,
      updatedRows: 0,
      skippedRows: skipped,
      quarantinedRecords: 0,
      validRows: tally.VALID,
      warningRows: tally.WARNING,
      quarantinedRows: tally.QUARANTINED,
      totals: { amount: Math.round(totals.amount * 100) / 100, shares: totals.shares },
      alreadyImported: false,
      chunks,
      peakRssMb: 0,
      peakHeapMb: 0,
      durationMs: 0,
    };

    if (client) {
      // Holders, grouped by Postgres, merged chunk by chunk.
      const actionsFor = new Map<string, CorporateActionLike[]>();
      const actions = async (companyId: string) => {
        if (!actionsFor.has(companyId)) {
          const rows = await db.corporateAction.findMany({ where: { companyId } });
          actionsFor.set(
            companyId,
            rows.map((a) => ({
              actionType: a.actionType,
              exDate: a.exDate.toISOString().slice(0, 10),
              ratioFrom: a.ratioFrom === null ? null : Number(a.ratioFrom),
              ratioTo: a.ratioTo === null ? null : Number(a.ratioTo),
              dividendPerShare: a.dividendPerShare === null ? null : Number(a.dividendPerShare),
            })),
          );
        }
        return actionsFor.get(companyId)!;
      };
      let copyMs = 0;
      let mergeMs = 0;
      await client.query("BEGIN");
      await client.query(`DECLARE holders NO SCROLL CURSOR FOR ${GROUPED_SQL}`);
      for (;;) {
        const { rows } = await client.query(`FETCH ${chunkSize} FROM holders`);
        if (!rows.length) break;
        const staged: StagedFolio[] = [];
        for (const g of rows) {
          const rep = g.rep as Line;
          const latest = g.latest as Line;
          const clean = g.clean_rel as Line | null;
          const useClean = clean && (rep.relSuspect || !rep.fatherOrSpouse);
          const issues = [
            ...new Set(
              String(g.issue_list ?? "")
                .split(",")
                .filter(Boolean),
            ),
          ] as IssueCode[];
          const status = statusOf(issues);
          const shares = Number(g.shares ?? 0);
          const eventDate = latest.eventDate ? new Date(latest.eventDate) : null;
          const after = eventDate ? eventDate.toISOString().slice(0, 10) : null;
          const computed =
            shares > 0 && after
              ? computeEntitlement(shares, await actions(g.company_id), { acquiredOn: after })
                  .shares
              : shares;
          if (status === "QUARANTINED") result.quarantinedRecords++;
          staged.push({
            companyId: g.company_id,
            investorFirstName: rep.first,
            investorMiddleName: rep.middle || null,
            investorLastName: rep.last || null,
            investorFullName: [rep.first, rep.middle, rep.last].filter(Boolean).join(" "),
            fatherOrSpouseName: useClean ? clean!.fatherOrSpouse : rep.fatherOrSpouse,
            fatherOrSpouseRaw: useClean ? clean!.fatherOrSpouseRaw : rep.fatherOrSpouseRaw,
            addressLine: rep.address,
            city: rep.city,
            state: rep.state,
            pincode: rep.pincode,
            folioNumber: rep.folioNumber,
            folioNumberMasked: rep.folioNumberMasked,
            folioNumberHash: rep.folioNumberHash,
            certificateNumbers: rep.certificates,
            originalShares: shares,
            postActionShares: after ? Math.max(shares, computed) : computed,
            amountsByEvent: Object.fromEntries(
              Object.entries(g.amounts as Record<string, unknown>).map(([k, v]) => [k, Number(v)]),
            ),
            custodyStatus:
              form === "IEPF_4"
                ? opts.shareBasis === "PROPOSED_IEPF_TRANSFER"
                  ? "DUE_FOR_IEPF_TRANSFER"
                  : "IEPF_AUTHORITY"
                : shares > 0
                  ? "COMPANY_SUSPENSE"
                  : "PHYSICAL_DORMANT",
            eventDate,
            transferFinancialYear: latest.transferFinancialYear,
            investmentType: rep.investmentType,
            sourceFilingSrn: rep.srn,
            ingestionJobId: opts.jobId ?? null,
            validationStatus: status,
            validationIssues: issues,
            reviewStatus: status === "QUARANTINED" ? "QUARANTINED" : "PUBLISHED",
            sourceDocumentId: documentId,
            sourceRowIds: g.rids as string[],
            quantityBasis: shares > 0 ? "SHARES_AS_STATED_ON_EVENT_DATE" : "AMOUNT_ONLY",
            quantityEffectiveDate: shares > 0 ? eventDate : null,
            ...folioSearchColumns({ first: rep.first, middle: rep.middle, last: rep.last }),
          });
        }
        const bulk = await bulkUpsertFolios(staged, { form, databaseUrl: opts.databaseUrl });
        result.insertedRows += bulk.inserted;
        result.updatedRows += bulk.updated;
        copyMs += bulk.copyMs;
        mergeMs += bulk.mergeMs;
        sample();
      }
      await client.query("CLOSE holders");
      await client.query("COMMIT");
      result.timings = { copyMs, mergeMs };

      if (documentId) {
        await db.sourceDocument.update({
          where: { id: documentId },
          data: {
            status: "IMPORTED",
            statusDetail: null,
            companyId: opts.companyId ?? (companyIds.size === 1 ? [...companyIds][0]! : undefined),
            rowCount: total,
            validRows: tally.VALID,
            warningRows: tally.WARNING,
            quarantinedRows: tally.QUARANTINED,
          },
        });
        // Hash join on the row key (see ingestStatement): unnest the record's row ids.
        await db.$executeRaw`
          UPDATE source_rows r SET folio_id = x.id, folio_state = x.state
            FROM (SELECT f.id, f.state, unnest(f.source_row_ids) AS row_id
                    FROM unclaimed_folios f
                   WHERE f.source_document_id = ${documentId}::uuid) x
           WHERE r.id = x.row_id
             AND r.source_document_id = ${documentId}::uuid
             AND r.folio_id IS NULL`;
        result.dividendEvents = {
          written: evTotals.written,
          amountTotal: Math.round(evTotals.amountTotal * 100) / 100,
        };
        if (opts.shareBasis) result.shareSnapshots = snapshots;
      }
    }
    sample();
    result.peakRssMb = Math.round(peakRss / 1048576);
    result.peakHeapMb = Math.round(peakHeap / 1048576);
    result.durationMs = Math.round(performance.now() - started);
    return result;
  } catch (e) {
    if (documentId)
      await db.sourceDocument
        .update({
          where: { id: documentId },
          data: {
            status: "IMPORT_FAILED",
            statusDetail: String((e as Error).message).slice(0, 500),
          },
        })
        .catch(() => {});
    throw e;
  } finally {
    await client?.end().catch(() => {});
  }
}
