import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

import { LOCAL_DATABASE_URL } from "./local-url.js";

/**
 * Bulk loading for multi-million-row IEPF statements. Rows stream into a
 * temporary staging table with PostgreSQL's binary COPY protocol, then one
 * set-based statement merges them into the partitioned `unclaimed_folios`:
 * existing holders (same company, folio and name) gain the new statement's
 * amounts, everyone else is inserted. No row-by-row round trips.
 */

export interface StagedFolio {
  companyId: string;
  investorFirstName: string;
  investorMiddleName: string | null;
  investorLastName: string | null;
  investorFullName: string;
  fatherOrSpouseName: string | null;
  addressLine: string | null;
  city: string | null;
  state: string;
  pincode: string | null;
  folioNumber: string;
  folioNumberMasked: string;
  folioNumberHash: string;
  certificateNumbers: string | null;
  originalShares: number;
  postActionShares: number;
  /** Rupees per statement date, e.g. { "2019-08-01": 120.5 }. */
  amountsByEvent: Record<string, number>;
  /** Custody for a new row; existing rows keep theirs unless the statement is an IEPF-4. */
  custodyStatus: string;
  eventDate: Date | null;
  transferFinancialYear: string | null;
  investmentType: string | null;
  sourceFilingSrn: string | null;
  fullNameNorm: string;
  firstNameNorm: string;
  middleNameNorm: string;
  lastNameNorm: string;
  firstNameKey: string;
  middleNameKey: string;
  lastNameKey: string;
  ingestionJobId: string | null;
  /** Father/spouse text exactly as the source gave it. */
  fatherOrSpouseRaw: string | null;
  validationStatus: "VALID" | "WARNING" | "QUARANTINED";
  validationIssues: string[];
  /** QUARANTINED rows are stored but not searchable until reviewed. */
  reviewStatus: "PUBLISHED" | "QUARANTINED";
  sourceDocumentId: string | null;
  sourceRowIds: string[];
  quantityBasis: string | null;
  quantityEffectiveDate: Date | null;
}

/* ── Binary COPY encoding ─────────────────────────────────────────────── */

/** "list" columns travel as comma-joined text and are cast to arrays on insert. */
type ColType = "uuid" | "text" | "int4" | "jsonb" | "date" | "list";

const COLUMNS: [keyof StagedFolio | "id", string, ColType][] = [
  ["id", "id", "uuid"],
  ["companyId", "company_id", "uuid"],
  ["investorFirstName", "investor_first_name", "text"],
  ["investorMiddleName", "investor_middle_name", "text"],
  ["investorLastName", "investor_last_name", "text"],
  ["investorFullName", "investor_full_name", "text"],
  ["fatherOrSpouseName", "father_or_spouse_name", "text"],
  ["addressLine", "address_line", "text"],
  ["city", "city", "text"],
  ["state", "state", "text"],
  ["pincode", "pincode", "text"],
  ["folioNumber", "folio_number", "text"],
  ["folioNumberMasked", "folio_number_masked", "text"],
  ["folioNumberHash", "folio_number_hash", "text"],
  ["certificateNumbers", "certificate_numbers", "text"],
  ["originalShares", "original_shares", "int4"],
  ["postActionShares", "post_action_shares", "int4"],
  ["amountsByEvent", "amounts_by_event", "jsonb"],
  ["custodyStatus", "custody_status", "text"],
  ["eventDate", "event_date", "date"],
  ["transferFinancialYear", "transfer_financial_year", "text"],
  ["investmentType", "investment_type", "text"],
  ["sourceFilingSrn", "source_filing_srn", "text"],
  ["fullNameNorm", "full_name_norm", "text"],
  ["firstNameNorm", "first_name_norm", "text"],
  ["middleNameNorm", "middle_name_norm", "text"],
  ["lastNameNorm", "last_name_norm", "text"],
  ["firstNameKey", "first_name_key", "text"],
  ["middleNameKey", "middle_name_key", "text"],
  ["lastNameKey", "last_name_key", "text"],
  ["ingestionJobId", "ingestion_job_id", "uuid"],
  ["fatherOrSpouseRaw", "father_or_spouse_raw", "text"],
  ["validationStatus", "validation_status", "text"],
  ["validationIssues", "validation_issues", "list"],
  ["reviewStatus", "review_status", "text"],
  ["sourceDocumentId", "source_document_id", "uuid"],
  ["sourceRowIds", "source_row_ids", "list"],
  ["quantityBasis", "quantity_basis", "text"],
  ["quantityEffectiveDate", "quantity_effective_date", "date"],
];

/** Array element type of each "list" column. */
const LIST_TYPE: Record<string, string> = {
  validation_issues: "text[]",
  source_row_ids: "uuid[]",
};

const SQL_TYPE: Record<ColType, string> = {
  uuid: "uuid",
  text: "text",
  int4: "integer",
  jsonb: "jsonb",
  date: "date",
  list: "text",
};

const SIGNATURE = Buffer.from("PGCOPY\n\xff\r\n\0", "latin1");
const PG_EPOCH_DAYS = Date.UTC(2000, 0, 1) / 86_400_000;

function field(type: ColType, value: unknown): Buffer {
  if (value === null || value === undefined) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(-1);
    return b;
  }
  let data: Buffer;
  switch (type) {
    case "uuid":
      data = Buffer.from(String(value).replace(/-/g, ""), "hex");
      break;
    case "text":
      data = Buffer.from(String(value), "utf8");
      break;
    case "list":
      data = Buffer.from((value as string[]).join(","), "utf8");
      break;
    case "int4":
      data = Buffer.alloc(4);
      data.writeInt32BE(Number(value));
      break;
    case "jsonb":
      // jsonb binary format: a version byte (1), then the JSON text.
      data = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value), "utf8")]);
      break;
    case "date":
      data = Buffer.alloc(4);
      data.writeInt32BE(Math.floor((value as Date).getTime() / 86_400_000) - PG_EPOCH_DAYS);
      break;
  }
  const len = Buffer.alloc(4);
  len.writeInt32BE(data.length);
  return Buffer.concat([len, data]);
}

/** One staged row as a binary COPY tuple. */
export function encodeTuple(row: StagedFolio & { id: string }): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(COLUMNS.length);
  return Buffer.concat([
    count,
    ...COLUMNS.map(([key, , type]) => field(type, row[key as keyof typeof row])),
  ]);
}

function* binaryCopy(rows: Iterable<StagedFolio>, counter: { n: number }): Generator<Buffer> {
  const header = Buffer.alloc(8); // flags + header-extension length, both zero
  yield Buffer.concat([SIGNATURE, header]);
  let chunk: Buffer[] = [];
  let size = 0;
  for (const row of rows) {
    counter.n++;
    const t = encodeTuple({ ...row, id: randomUUID() });
    chunk.push(t);
    size += t.length;
    if (size > 1 << 20) {
      yield Buffer.concat(chunk);
      chunk = [];
      size = 0;
    }
  }
  const trailer = Buffer.alloc(2);
  trailer.writeInt16BE(-1);
  chunk.push(trailer);
  yield Buffer.concat(chunk);
}

/* ── Merge ────────────────────────────────────────────────────────────── */

const cols = COLUMNS.map(([, c]) => c);
const stageDdl = (table: string) =>
  `CREATE UNLOGGED TABLE ${table} (${COLUMNS.map(([, c, t]) => `${c} ${SQL_TYPE[t]}`).join(", ")})`;

/** Columns copied as-is into a new row, with enum casts where needed. */
const insertExpr = (c: string) =>
  c === "state"
    ? `s.state::"IndianState"`
    : c === "custody_status"
      ? `s.custody_status::"CustodyStatus"`
      : LIST_TYPE[c]
        ? listExpr(`s.${c}`, c)
        : `s.${c}`;

function listExpr(expr: string, column: string) {
  return `COALESCE(string_to_array(NULLIF(${expr}, ''), ',')::${LIST_TYPE[column]}, '{}')`;
}

/**
 * Columns a provenance-aware re-import refreshes on an existing holder: the
 * corrected normalised values, their raw source text and validation. A
 * quarantine is never lifted here (only a reviewer publishes), and a
 * withdrawn record stays withdrawn.
 */
const REFRESHED: Record<string, string> = {
  father_or_spouse_name:
    "CASE WHEN s.source_document_id IS NULL THEN f.father_or_spouse_name ELSE s.father_or_spouse_name END",
  father_or_spouse_raw: "COALESCE(s.father_or_spouse_raw, f.father_or_spouse_raw)",
  address_line: "COALESCE(s.address_line, f.address_line)",
  validation_status:
    "CASE WHEN s.source_document_id IS NULL THEN f.validation_status ELSE s.validation_status END",
  validation_issues: `CASE WHEN s.source_document_id IS NULL THEN f.validation_issues ELSE ${listExpr("s.validation_issues", "validation_issues")} END`,
  review_status:
    "CASE WHEN f.review_status = 'WITHDRAWN' THEN 'WITHDRAWN' WHEN s.review_status = 'QUARANTINED' THEN 'QUARANTINED' ELSE f.review_status END",
  source_document_id: "COALESCE(s.source_document_id, f.source_document_id)",
  source_row_ids: `ARRAY(SELECT DISTINCT unnest(f.source_row_ids || ${listExpr("s.source_row_ids", "source_row_ids")}))`,
  quantity_basis: "COALESCE(s.quantity_basis, f.quantity_basis)",
  quantity_effective_date: "COALESCE(s.quantity_effective_date, f.quantity_effective_date)",
};

const MATCH = `f.company_id = s.company_id
    AND f.folio_number_hash = s.folio_number_hash
    AND f.investor_full_name = s.investor_full_name`;

const sumOf = (json: string) =>
  `(SELECT COALESCE(round(sum(value::numeric), 2), 0) FROM jsonb_each_text(${json}))`;

/** SET clause shared by in-place updates: the new statement's facts win, amounts add up per date. */
/**
 * Custody only moves forward: a later dividend list or "due for transfer" list
 * never undoes a recorded transfer to the IEPF.
 */
const CUSTODY_MERGE = `CASE
      WHEN f.custody_status = 'IEPF_AUTHORITY' OR s.custody_status = 'IEPF_AUTHORITY' THEN 'IEPF_AUTHORITY'::"CustodyStatus"
      WHEN s.custody_status = 'DUE_FOR_IEPF_TRANSFER' THEN 'DUE_FOR_IEPF_TRANSFER'::"CustodyStatus"
      ELSE f.custody_status END`;

function mergeSet(_form: Form) {
  const custody = CUSTODY_MERGE;
  return `
    custody_status = ${custody},
    original_shares = CASE WHEN s.original_shares > 0 THEN s.original_shares ELSE f.original_shares END,
    post_action_shares = CASE WHEN s.original_shares > 0 THEN s.post_action_shares ELSE f.post_action_shares END,
    amounts_by_event = f.amounts_by_event || s.amounts_by_event,
    unclaimed_dividend_amount = ${sumOf("f.amounts_by_event || s.amounts_by_event")},
    event_date = COALESCE(s.event_date, f.event_date),
    transfer_financial_year = COALESCE(s.transfer_financial_year, f.transfer_financial_year),
    investment_type = COALESCE(s.investment_type, f.investment_type),
    source_filing_srn = COALESCE(s.source_filing_srn, f.source_filing_srn),
    ingestion_job_id = COALESCE(s.ingestion_job_id, f.ingestion_job_id),
    ${Object.entries(REFRESHED)
      .map(([c, e]) => `${c} = ${e}`)
      .join(",\n    ")},
    updated_at = now()`;
}

const insertNew = (target: string, stage: string, where: string) => `
  INSERT INTO ${target} (${cols.join(", ")}, unclaimed_dividend_amount, created_at, updated_at)
  SELECT ${cols.map(insertExpr).join(", ")}, ${sumOf("s.amounts_by_event")}, now(), now()
  FROM ${stage} s
  WHERE ${where}`;

/** Small imports: update matches in place and insert the rest, in one statement. */
function mergeSql(form: Form, stage: string) {
  return `
WITH upd AS (
  UPDATE unclaimed_folios f SET ${mergeSet(form)}
  FROM ${stage} s
  WHERE ${MATCH}
  RETURNING s.id AS stage_id
), ins AS (
  ${insertNew("unclaimed_folios", stage, "NOT EXISTS (SELECT 1 FROM upd WHERE upd.stage_id = s.id)")}
  RETURNING 1
)
SELECT (SELECT count(DISTINCT stage_id) FROM upd)::int AS updated,
       (SELECT count(*) FROM ins)::int AS inserted`;
}

type Form = "IEPF_2" | "IEPF_4";

export interface BulkResult {
  inserted: number;
  updated: number;
  copyMs: number;
  mergeMs: number;
  /** "merge" (in place) or "rebuild" (unindexed load, parallel index build, partition swap). */
  mode: "merge" | "rebuild";
  /** State partitions rebuilt, in rebuild mode. */
  partitions?: number;
}

export interface BulkOptions {
  form: Form;
  databaseUrl?: string;
  /**
   * Above this many rows, affected state partitions are rebuilt instead of
   * updated in place: index maintenance on a live partition costs far more
   * than building the indexes once. Default 200,000.
   */
  rebuildAbove?: number;
  /** State partitions rebuilt at the same time. Default 4. */
  concurrency?: number;
  onPhase?: (message: string) => void;
}

const REBUILD_ABOVE = 200_000;

/**
 * Streams rows into Postgres with binary COPY, then either merges them in
 * place (small imports, one transaction) or rebuilds each affected state
 * partition (large imports). Uses its own connections: COPY needs a raw client.
 */
export async function bulkUpsertFolios(
  rows: Iterable<StagedFolio>,
  opts: BulkOptions,
): Promise<BulkResult> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
  const stage = `folio_stage_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(stageDdl(stage));
    const started = performance.now();
    const counter = { n: 0 };
    await pipeline(
      Readable.from(binaryCopy(rows, counter)),
      client.query(copyFrom(`COPY ${stage} (${cols.join(", ")}) FROM STDIN (FORMAT binary)`)),
    );
    const copied = performance.now();
    opts.onPhase?.(`copied ${counter.n} rows in ${Math.round(copied - started)} ms`);
    if (counter.n > 1000) await client.query(`ANALYZE ${stage}`);
    // New spellings join the vocabulary that fuzzy search matches against.
    await client.query(`
      INSERT INTO name_words
      SELECT DISTINCT w FROM (
        SELECT first_name_norm AS w FROM ${stage}
        UNION SELECT middle_name_norm FROM ${stage}
        UNION SELECT last_name_norm FROM ${stage}
      ) x
      WHERE length(w) > 1
      ON CONFLICT DO NOTHING`);

    if (counter.n <= (opts.rebuildAbove ?? REBUILD_ABOVE)) {
      await client.query("BEGIN");
      const res = await client.query<{ updated: number; inserted: number }>(
        mergeSql(opts.form, stage),
      );
      await client.query("COMMIT");
      return {
        inserted: res.rows[0]!.inserted,
        updated: res.rows[0]!.updated,
        copyMs: Math.round(copied - started),
        mergeMs: Math.round(performance.now() - copied),
        mode: "merge",
      };
    }

    const r = await rebuildPartitions(client, url, stage, opts);
    return {
      ...r,
      copyMs: Math.round(copied - started),
      mergeMs: Math.round(performance.now() - copied),
      mode: "rebuild",
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.query(`DROP TABLE IF EXISTS ${stage}`).catch(() => {});
    await client.end();
  }
}

/* ── Rebuild mode ─────────────────────────────────────────────────────── */

async function rebuildPartitions(
  client: pg.Client,
  url: string,
  stage: string,
  opts: BulkOptions,
): Promise<{ inserted: number; updated: number; partitions: number }> {
  let updated = 0;
  // Holders who moved state between statements are updated in place where
  // they are, so the per-state rebuild never duplicates them.
  const known = await client.query<{ company_id: string }>(
    `SELECT DISTINCT s.company_id FROM ${stage} s
     WHERE EXISTS (SELECT 1 FROM unclaimed_folios f WHERE f.company_id = s.company_id)`,
  );
  if (known.rows.length) {
    const moved = await client.query(`
      WITH x AS (
        UPDATE unclaimed_folios f SET ${mergeSet(opts.form)}
        FROM ${stage} s
        WHERE ${MATCH} AND f.state::text <> s.state
        RETURNING s.id AS stage_id
      )
      DELETE FROM ${stage} WHERE id IN (SELECT stage_id FROM x)`);
    updated += moved.rowCount ?? 0;
  }

  const states = (
    await client.query<{ state: string }>(`SELECT DISTINCT state FROM ${stage} ORDER BY 1`)
  ).rows.map((r) => r.state);
  const columns = (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'unclaimed_folios' AND is_generated = 'NEVER'
       ORDER BY ordinal_position`,
    )
  ).rows.map((r) => r.column_name);
  const indexDefs = (
    await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'unclaimed_folios' AND indexname <> 'unclaimed_folios_pkey'
       ORDER BY indexname`,
    )
  ).rows;

  let inserted = 0;
  const queue = [...states];
  const worker = async () => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      for (let state = queue.shift(); state; state = queue.shift()) {
        const r = await rebuildOne(c, stage, state, columns, indexDefs, opts);
        inserted += r.inserted;
        updated += r.updated;
        opts.onPhase?.(`${state}: ${r.inserted} new, ${r.updated} updated, swapped in ${r.ms} ms`);
      }
    } finally {
      await c.end();
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, states.length) }, worker));
  return { inserted, updated, partitions: states.length };
}

/**
 * One state: copy the live partition and the staged rows into an unindexed
 * table, build every index with parallel workers, then swap it in with
 * DETACH / ATTACH PARTITION. Searches keep reading the old partition until
 * the swap, which only holds its lock for the catalogue change.
 */
async function rebuildOne(
  c: pg.Client,
  stage: string,
  state: string,
  columns: string[],
  indexDefs: { indexname: string; indexdef: string }[],
  opts: BulkOptions,
): Promise<{ inserted: number; updated: number; ms: number }> {
  const started = performance.now();
  if (!/^[A-Z_]+$/.test(state)) throw new Error(`Unexpected state ${state}`);
  const part = `unclaimed_folios_${state.toLowerCase()}`;
  const load = `unclaimed_folios_load_${state.toLowerCase()}`;
  const lit = `'${state}'`;
  const custody = `CASE WHEN s.id IS NULL THEN f.custody_status ELSE ${CUSTODY_MERGE} END`;
  const merged: Record<string, string> = {
    custody_status: custody,
    original_shares:
      "CASE WHEN s.original_shares > 0 THEN s.original_shares ELSE f.original_shares END",
    post_action_shares:
      "CASE WHEN s.original_shares > 0 THEN s.post_action_shares ELSE f.post_action_shares END",
    amounts_by_event: "f.amounts_by_event || COALESCE(s.amounts_by_event, '{}'::jsonb)",
    unclaimed_dividend_amount: `CASE WHEN s.id IS NULL THEN f.unclaimed_dividend_amount
      ELSE ${sumOf("f.amounts_by_event || s.amounts_by_event")} END`,
    event_date: "COALESCE(s.event_date, f.event_date)",
    transfer_financial_year: "COALESCE(s.transfer_financial_year, f.transfer_financial_year)",
    investment_type: "COALESCE(s.investment_type, f.investment_type)",
    source_filing_srn: "COALESCE(s.source_filing_srn, f.source_filing_srn)",
    ingestion_job_id: "COALESCE(s.ingestion_job_id, f.ingestion_job_id)",
    ...Object.fromEntries(
      Object.entries(REFRESHED).map(([c, e]) => [
        c,
        `CASE WHEN s.id IS NULL THEN f.${c} ELSE ${e} END`,
      ]),
    ),
    updated_at: "CASE WHEN s.id IS NULL THEN f.updated_at ELSE now() END",
  };

  await c.query(`DROP TABLE IF EXISTS ${load}`);
  await c.query(
    `CREATE TABLE ${load} (LIKE unclaimed_folios INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED)`,
  );
  // 1. The live partition's rows, with matching staged rows merged in.
  const kept = await c.query<{ matched: number }>(`
    WITH ins AS (
      INSERT INTO ${load} (${columns.join(", ")})
      SELECT ${columns.map((col) => merged[col] ?? `f.${col}`).join(", ")}
      FROM ${part} f
      LEFT JOIN ${stage} s ON s.state = ${lit} AND ${MATCH}
      RETURNING (updated_at = now()) AS matched
    )
    SELECT count(*) FILTER (WHERE matched)::int AS matched FROM ins`);
  // 2. New holders.
  const added = await c.query(
    insertNew(
      load,
      stage,
      `s.state = ${lit} AND NOT EXISTS (SELECT 1 FROM ${part} f WHERE ${MATCH})`,
    ),
  );

  // 3. Indexes, built once with parallel workers, matching the parent's.
  await c.query("SET maintenance_work_mem = '2GB'");
  await c.query("SET max_parallel_maintenance_workers = 8");
  await c.query(`ALTER TABLE ${load} ADD CONSTRAINT ${load}_pkey PRIMARY KEY (id, state)`);
  for (const [i, idx] of indexDefs.entries()) {
    const def = idx.indexdef.replace(
      /^CREATE (UNIQUE )?INDEX \S+ ON ONLY public\.unclaimed_folios /,
      (_m, u) => `CREATE ${u ?? ""}INDEX ${load}_${i} ON public.${load} `,
    );
    if (def === idx.indexdef) throw new Error(`Cannot adapt index ${idx.indexname}`);
    await c.query(def);
  }
  await c.query(`ALTER TABLE ${load} ADD CONSTRAINT ${load}_state CHECK (state = ${lit})`);
  // Validated now, outside the swap's lock; ATTACH adopts them as the parent's keys.
  await c.query(`ALTER TABLE ${load}
    ADD CONSTRAINT ${load}_company_fk FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT ${load}_job_fk FOREIGN KEY (ingestion_job_id) REFERENCES ingestion_jobs(id) ON DELETE SET NULL ON UPDATE CASCADE`);
  await c.query(`ANALYZE ${load}`);

  // 4. Swap.
  await c.query("BEGIN");
  try {
    await c.query(`ALTER TABLE unclaimed_folios DETACH PARTITION ${part}`);
    await c.query(`ALTER TABLE unclaimed_folios ATTACH PARTITION ${load} FOR VALUES IN (${lit})`);
    await c.query(`DROP TABLE ${part}`);
    await c.query(`ALTER TABLE ${load} RENAME TO ${part}`);
    await c.query(`ALTER TABLE ${part} DROP CONSTRAINT ${load}_state`);
    await c.query(`ALTER INDEX ${load}_pkey RENAME TO ${part}_pkey`);
    for (const i of indexDefs.keys())
      await c.query(`ALTER INDEX ${load}_${i} RENAME TO ${part}_${i}`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    await c.query(`DROP TABLE IF EXISTS ${load}`).catch(() => {});
    throw e;
  }
  return {
    inserted: added.rowCount ?? 0,
    updated: kept.rows[0]!.matched,
    ms: Math.round(performance.now() - started),
  };
}
