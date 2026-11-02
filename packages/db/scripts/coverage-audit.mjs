#!/usr/bin/env node
/**
 * Read-only coverage audit. Prints aggregate counts only: no names, folio
 * numbers, addresses or any other personal data.
 *
 *   DATABASE_URL=... node packages/db/scripts/coverage-audit.mjs [--json]
 *
 * Every query runs inside a READ ONLY transaction, so the script cannot
 * change the database even by mistake.
 */
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED).");
  process.exit(2);
}

const client = new pg.Client({ connectionString: url, application_name: "coverage-audit" });
await client.connect();
await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

/** Queued, not run: the single client runs them one after another below. */
function q(label, sql) {
  return { label, sql };
}

async function run({ label, sql }) {
  try {
    const { rows } = await client.query(sql);
    return { label, rows };
  } catch (err) {
    return { label, error: String(err.message ?? err) };
  }
}

async function columnExists(table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

/** Placeholder-like father/spouse values, matched by shape only. */
const RELATIVE_PLACEHOLDER = `(
  father_or_spouse_name ~* '^\\s*(NA|N\\.A\\.?|NIL|NONE|-+|\\.+|0+)\\s*$'
  OR father_or_spouse_name ~* '^\\s*NA\\s'
  OR father_or_spouse_name ~* '(C/O|S/O|D/O|W/O)\\s*$'
  OR father_or_spouse_name ~ '[0-9]'
  OR father_or_spouse_name ~ '[,‐–-]\\s*$'
)`;

const hasSourceRows = await columnExists("unclaimed_folios", "source_row_id");

const sections = [
  q(
    "Totals",
    `SELECT
       (SELECT count(*) FROM listed_equities)                    AS listed_equities,
       (SELECT count(*) FROM companies)                          AS company_profiles,
       (SELECT count(*) FROM corporate_actions)                  AS corporate_actions,
       (SELECT count(*) FROM companies WHERE current_market_price IS NOT NULL) AS companies_with_price,
       (SELECT count(*) FROM unclaimed_folios)                   AS holder_records,
       (SELECT count(DISTINCT investor_cluster_id) FROM unclaimed_folios) AS record_groups,
       (SELECT count(*) FROM name_words)                         AS name_words,
       (SELECT count(*) FROM users)                              AS users,
       (SELECT count(*) FROM users WHERE role <> 'INVESTOR')     AS staff_or_partner_users,
       (SELECT count(*) FROM users WHERE role = 'SUPER_ADMIN')   AS administrators,
       (SELECT count(*) FROM leads_and_inquiries)                AS leads,
       (SELECT count(*) FROM recovery_cases)                     AS cases,
       (SELECT count(*) FROM valuation_reports)                  AS valuation_reports,
       (SELECT count(*) FROM ingestion_jobs)                     AS ingestion_jobs`,
  ),
  q(
    "Baseline (statement entries are not people or folios)",
    `WITH ev AS (
       SELECT f.company_id, f.folio_number_hash, f.investor_full_name, e.key AS event_key
         FROM unclaimed_folios f, jsonb_each(f.amounts_by_event) e)
     SELECT
       (SELECT count(*) FROM unclaimed_folios)                                     AS statement_entries,
       (SELECT count(DISTINCT (company_id, folio_number_hash)) FROM unclaimed_folios) AS distinct_company_folio,
       (SELECT count(*) FROM ev)                                                   AS holder_dividend_event_pairs,
       (SELECT count(DISTINCT (company_id, event_key)) FROM ev)                    AS distinct_company_dividend_events,
       (SELECT count(*) FROM unclaimed_folios WHERE original_shares > 0)           AS records_with_explicit_shares,
       (SELECT count(*) FROM recovery_cases WHERE demat_credit_status = 'DONE')    AS entitlements_confirmed_by_credit,
       (SELECT count(DISTINCT company_id) FROM unclaimed_folios)                   AS companies_with_entries,
       (SELECT array_agg(DISTINCT transfer_financial_year ORDER BY transfer_financial_year)
          FROM unclaimed_folios WHERE transfer_financial_year IS NOT NULL)         AS transfer_financial_years,
       (SELECT array_agg(DISTINCT left(event_key, 4) ORDER BY left(event_key, 4)) FROM ev) AS event_years,
       (SELECT array_agg(DISTINCT CASE WHEN original_shares > 0 THEN 'EQUITY_SHARES' ELSE 'UNCLAIMED_DIVIDEND_AMOUNT' END)
          FROM unclaimed_folios)                                                   AS asset_classes`,
  ),
  q(
    "Holder records by company and custody category",
    `SELECT c.name AS company, f.custody_status, count(*) AS records,
            count(DISTINCT f.investor_cluster_id) AS record_groups,
            count(DISTINCT f.folio_number_hash) AS distinct_folios
       FROM unclaimed_folios f JOIN companies c ON c.id = f.company_id
      GROUP BY 1, 2 ORDER BY 3 DESC`,
  ),
  q(
    "Company profiles with zero holder records",
    `SELECT count(*) AS profiles_without_holders,
            array_agg(c.name ORDER BY c.name) AS companies
       FROM companies c
      WHERE NOT EXISTS (SELECT 1 FROM unclaimed_folios f WHERE f.company_id = c.id)`,
  ),
  q(
    "Statement periods (event date / transfer FY / investment type)",
    `SELECT c.name AS company,
            count(DISTINCT f.transfer_financial_year) AS distinct_fy,
            min(f.event_date) AS earliest_event, max(f.event_date) AS latest_event,
            count(*) FILTER (WHERE f.event_date IS NULL) AS no_event_date,
            count(DISTINCT f.investment_type) AS investment_types
       FROM unclaimed_folios f JOIN companies c ON c.id = f.company_id
      GROUP BY 1 ORDER BY 1`,
  ),
  q(
    "Distinct source files (ingestion jobs)",
    `SELECT j.status, j.form_type, count(*) AS jobs, sum(j.total_rows) AS rows_read,
            sum(j.inserted_rows) AS inserted, sum(j.updated_rows) AS updated,
            sum(j.skipped_rows) AS skipped, max(j.finished_at) AS latest_finished
       FROM ingestion_jobs j GROUP BY 1, 2 ORDER BY 1, 2`,
  ),
  q(
    "Holder records by ingestion job linkage",
    `SELECT (ingestion_job_id IS NOT NULL) AS linked_to_job, count(*) AS records
       FROM unclaimed_folios GROUP BY 1`,
  ),
  q(
    "Holder records by state (top 40)",
    `SELECT state, count(*) AS records FROM unclaimed_folios GROUP BY 1 ORDER BY 2 DESC LIMIT 40`,
  ),
  q(
    "Missing or malformed identity fields",
    `SELECT
       count(*) FILTER (WHERE coalesce(trim(father_or_spouse_name), '') = '') AS relative_blank,
       count(*) FILTER (WHERE ${RELATIVE_PLACEHOLDER})                         AS relative_placeholder_like,
       count(*) FILTER (WHERE father_or_spouse_name ~* '^\\s*NA\\s')           AS relative_starts_na_space,
       count(*) FILTER (WHERE father_or_spouse_name ~ '[0-9]')                 AS relative_has_digit,
       count(*) FILTER (WHERE coalesce(trim(address_line), '') = '')           AS address_blank,
       count(*) FILTER (WHERE pincode IS NULL OR pincode !~ '^[1-9][0-9]{5}$') AS pincode_missing_or_bad,
       count(*) FILTER (WHERE coalesce(trim(city), '') = '')                   AS city_blank,
       count(*) FILTER (WHERE state = 'UNKNOWN')                               AS state_unknown,
       count(*) FILTER (WHERE length(trim(investor_full_name)) < 3)            AS name_too_short,
       count(*) FILTER (WHERE investor_full_name ~ '[0-9]')                    AS name_has_digit,
       count(*) FILTER (WHERE coalesce(investor_last_name, '') = '')           AS last_name_blank
     FROM unclaimed_folios`,
  ),
  q(
    "Duplicate source rows",
    `SELECT
       (SELECT count(*) FROM (
          SELECT company_id, folio_number_hash, investor_full_name FROM unclaimed_folios
           GROUP BY 1, 2, 3 HAVING count(*) > 1) d)                      AS same_company_folio_name_groups,
       (SELECT coalesce(sum(n - 1), 0) FROM (
          SELECT count(*) AS n FROM unclaimed_folios
           GROUP BY company_id, folio_number_hash, investor_full_name HAVING count(*) > 1) d) AS surplus_rows,
       (SELECT count(*) FROM (
          SELECT company_id, folio_number_hash FROM unclaimed_folios
           GROUP BY 1, 2 HAVING count(DISTINCT investor_full_name) > 1) d) AS folios_with_multiple_names`,
  ),
  q(
    "Unknown quantity or valuation",
    `SELECT
       count(*) FILTER (WHERE original_shares = 0 AND post_action_shares = 0) AS zero_shares,
       count(*) FILTER (WHERE original_shares > 0)                             AS has_shares,
       count(*) FILTER (WHERE unclaimed_dividend_amount = 0)                   AS zero_amount,
       count(*) FILTER (WHERE unclaimed_dividend_amount > 0)                   AS has_amount,
       count(*) FILTER (WHERE original_shares = 0 AND unclaimed_dividend_amount = 0) AS neither,
       count(*) FILTER (WHERE post_action_shares <> original_shares)           AS derived_differs
     FROM unclaimed_folios`,
  ),
  q(
    "Investment types",
    `SELECT investment_type, custody_status, count(*) AS records
       FROM unclaimed_folios GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
  ),
  q(
    "Price coverage and freshness",
    `SELECT price_source, count(*) AS companies,
            min(price_updated_at) AS oldest, max(price_updated_at) AS newest
       FROM companies GROUP BY 1 ORDER BY 2 DESC`,
  ),
  q(
    "Corporate actions by type and source",
    `SELECT action_type, source, count(*) AS actions, count(DISTINCT company_id) AS companies,
            min(ex_date) AS earliest, max(ex_date) AS latest
       FROM corporate_actions GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
  ),
  q(
    "Companies without corporate-action history",
    `SELECT count(*) AS companies FROM companies c
      WHERE NOT EXISTS (SELECT 1 FROM corporate_actions a WHERE a.company_id = c.id)`,
  ),
  q(
    "Company contact/source metadata",
    `SELECT count(*) FILTER (WHERE ir_page_url IS NOT NULL) AS with_ir_page,
            count(*) FILTER (WHERE contacts_verified_at IS NOT NULL) AS contacts_verified,
            max(contacts_verified_at) AS latest_contacts_verified
       FROM companies`,
  ),
  q(
    "Latest audit events by action (counts only)",
    `SELECT action, count(*) AS events, max(created_at) AS latest
       FROM audit_events GROUP BY 1 ORDER BY 3 DESC LIMIT 25`,
  ),
];

if (hasSourceRows) {
  sections.push(
    q(
      "Source documents (provenance)",
      `SELECT d.status, d.review_status, count(*) AS documents, max(d.retrieved_at) AS latest_retrieved,
              max(d.published_at) AS latest_published
         FROM source_documents d GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
    q(
      "Source rows by validation status",
      `SELECT validation_status, count(*) AS rows FROM source_rows GROUP BY 1 ORDER BY 2 DESC`,
    ),
  );
}

const results = [];
for (const s of sections) results.push(await run(s));
await client.query("ROLLBACK");
await client.end();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? String(v) : v), 2));
} else {
  for (const r of results) {
    console.log(`\n## ${r.label}`);
    if (r.error) console.log(`  (query failed: ${r.error})`);
    else console.table(r.rows);
  }
}
