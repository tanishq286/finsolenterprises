/**
 * Nationwide acquisition, run against a staging database:
 *
 *   acquire universe                         load NSE current, SME, delisted lists and aliases
 *   acquire seed <file.csv>                  apply reviewed websites / investor pages
 *   acquire enqueue [--all] [--force] [--limit N]  queue discovery for issuers with a website
 *                                            (--force ignores the next review date)
 *   acquire work [--concurrency 6] [--minutes 30]
 *   acquire report [--json]                  aggregate coverage (no personal data)
 *   acquire export <path.json>               machine-readable source register
 *
 * Refuses a non-local database unless --confirm-production is given, and
 * this workstream does not approve that.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import pg from "pg";

import { createPrismaClient, keysFromEnv } from "../index.js";
import { applySeeds, loadUniverse } from "../acquisition/register.js";
import { enqueue, work, type JobKind } from "../acquisition/worker.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      limit: { type: "string" },
      concurrency: { type: "string", default: "6" },
      minutes: { type: "string", default: "30" },
      kinds: { type: "string" },
      json: { type: "boolean", default: false },
      "confirm-production": { type: "boolean", default: false },
    },
  });
  for (const [name, raw, max] of [
    ["concurrency", values.concurrency, 16],
    ["minutes", values.minutes, 1440],
    ["limit", values.limit ?? "100000", 100000],
  ] as const) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  if (
    values.kinds &&
    values.kinds.split(",").some((k) => !["DISCOVER", "FETCH", "PARSE"].includes(k))
  )
    throw new Error("kinds must contain DISCOVER, FETCH or PARSE.");
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to the staging database.");
  if (!/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url) && !values["confirm-production"])
    throw new Error("Not a local database. Acquisition runs against staging only.");
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const db = createPrismaClient(url);
  const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  try {
    const [cmd, arg] = positionals;
    if (cmd === "universe") {
      log(JSON.stringify(await loadUniverse(pool)));
    } else if (cmd === "seed") {
      if (!arg) throw new Error("Pass the seed CSV path.");
      log(`${await applySeeds(pool, arg)} register rows updated from ${arg}`);
    } else if (cmd === "enqueue") {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM source_register
          WHERE ${values.all ? "TRUE" : "(website IS NOT NULL OR ir_url IS NOT NULL)"}
            AND (${values.force ? "TRUE" : "next_review_at IS NULL OR next_review_at <= now()"})
          ORDER BY (ir_url IS NULL), name LIMIT $1`,
        [Number(values.limit ?? 100000)],
      );
      for (const r of rows) await enqueue(pool, "DISCOVER", r.id);
      log(`queued ${rows.length} discovery jobs`);
    } else if (cmd === "work") {
      const stats = await work(
        { db, pool, keys: keysFromEnv(), databaseUrl: url, log },
        {
          concurrency: Number(values.concurrency),
          deadline: Date.now() + Number(values.minutes) * 60_000,
          kinds: values.kinds?.split(",") as JobKind[] | undefined,
        },
      );
      log(JSON.stringify(stats));
    } else if (cmd === "report") {
      const report = await coverageReport(pool);
      console.log(values.json ? JSON.stringify(report, null, 2) : report);
    } else if (cmd === "export") {
      if (!arg) throw new Error("Pass the output path.");
      const { rows } = await pool.query(
        `SELECT r.company_key, r.name, r.aliases, r.isin, r.nse_symbol, r.listing_status, r.website, r.website_basis,
                r.ir_url, r.ir_url_basis, r.registrar, r.registrar_contact_url, r.access_method, r.bulk_access,
                r.permitted_use_note, r.last_attempt_at, r.last_result, r.last_result_detail, r.next_review_at,
                coalesce(json_agg(json_build_object(
                  'url', d.url, 'class', d.doc_class, 'period_hint', d.period_hint, 'status', d.status,
                  'http_last_modified', d.http_last_modified, 'sha256', d.sha256, 'fetched_at', d.fetched_at,
                  'source_document_id', d.source_document_id) ORDER BY d.url) FILTER (WHERE d.id IS NOT NULL), '[]') AS documents
           FROM source_register r LEFT JOIN register_documents d ON d.register_id = r.id
          GROUP BY r.id ORDER BY (r.last_result IS NULL), r.name`,
      );
      await writeFile(
        arg,
        JSON.stringify({ generatedAt: new Date().toISOString(), issuers: rows }, null, 1),
      );
      log(`wrote ${rows.length} issuers to ${arg}`);
    } else {
      throw new Error("Commands: universe | seed | enqueue | work | report | export");
    }
  } finally {
    await pool.end();
    await db.$disconnect();
  }
}

export async function coverageReport(pool: pg.Pool) {
  const one = async (sql: string) => (await pool.query(sql)).rows;
  return {
    register: await one(`SELECT listing_status, count(*)::int AS issuers,
        count(*) FILTER (WHERE website IS NOT NULL OR ir_url IS NOT NULL)::int AS with_site,
        count(*) FILTER (WHERE last_attempt_at IS NOT NULL)::int AS attempted
        FROM source_register GROUP BY 1 ORDER BY 2 DESC`),
    discovery:
      await one(`SELECT coalesce(last_result, 'NOT_ATTEMPTED') AS result, bulk_access, count(*)::int AS issuers
        FROM source_register GROUP BY 1, 2 ORDER BY 3 DESC`),
    documents: await one(
      `SELECT doc_class, status, count(*)::int AS documents FROM register_documents GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    imports: await one(`SELECT r.name AS company, count(DISTINCT d.sha256)::int AS files,
        min(d.period_hint) AS first_period, max(d.period_hint) AS last_period,
        sum((d.status_detail::jsonb->>'valid')::int + (d.status_detail::jsonb->>'warning')::int)::int AS accepted_rows,
        sum((d.status_detail::jsonb->>'quarantined')::int)::int AS quarantined_rows,
        sum((d.status_detail::jsonb->>'events')::int)::int AS dividend_events,
        sum((d.status_detail::jsonb->>'snapshots')::int)::int AS share_snapshots
        FROM register_documents d JOIN source_register r ON r.id = d.register_id
       WHERE d.status = 'IMPORTED' GROUP BY 1 ORDER BY 1`),
    events: await one(`SELECT count(*)::int AS holder_dividend_events,
        count(*) FILTER (WHERE superseded_by_id IS NOT NULL)::int AS superseded,
        count(*) FILTER (WHERE cardinality(source_document_ids) > 1)::int AS republished,
        count(DISTINCT (company_id, event_key))::int AS distinct_company_events,
        count(DISTINCT (company_id, folio_number_hash))::int AS distinct_company_folios
        FROM holder_dividend_events`),
    snapshots: await one(`SELECT basis, count(*)::int AS snapshots, sum(shares)::bigint AS shares,
        count(DISTINCT (company_id, folio_number_hash))::int AS distinct_company_folios,
        count(*) FILTER (WHERE superseded_by_id IS NOT NULL)::int AS superseded
        FROM shareholding_snapshots GROUP BY 1`),
    verifications: await one(`SELECT state, count(*)::int AS documents FROM record_verifications
        WHERE entity_type = 'SOURCE_DOCUMENT' GROUP BY 1 ORDER BY 1`),
    jobs: await one(
      `SELECT kind, status, count(*)::int AS jobs FROM acquisition_jobs GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  };
}

if (process.argv[1]?.endsWith("acquire.js"))
  main().catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
