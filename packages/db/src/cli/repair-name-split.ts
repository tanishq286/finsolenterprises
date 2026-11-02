/**
 * Re-splits stored holder names that have no last name, so name search finds
 * them. Filings often put the whole name in one column ("NAMITA MAJI" as the
 * first name) or a two-word name in the first and middle columns; search
 * splits a typed name into first / middle / last, so those records never
 * matched. The new split is canonicalNameParts (the rule ingestion now uses).
 *
 *   node dist/cli/repair-name-split.js                          dry run (counts only)
 *   node dist/cli/repair-name-split.js --apply                  back up, then apply
 *   node dist/cli/repair-name-split.js --rollback <backup>      undo an apply
 *
 * Rules:
 * - Only the first / middle / last name and phonetic key columns change; the
 *   full name, folio, amounts and everything else stay as they are.
 * - Reports counts only; names are never printed.
 * - --apply or --rollback against a non-local database also needs --confirm-production.
 * - Before applying, the old values of every changed record are copied to a
 *   backup table (backup_name_split_<time>) that --rollback restores from.
 */
import "dotenv/config";
import { parseArgs } from "node:util";

import pg from "pg";

import { folioSearchColumns } from "../columns.js";

const BATCH = 1000;
const NAME_COLS = [
  "first_name_norm",
  "middle_name_norm",
  "last_name_norm",
  "first_name_key",
  "middle_name_key",
  "last_name_key",
] as const;

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    rollback: { type: "string" },
    "confirm-production": { type: "boolean", default: false },
  },
});

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Set DATABASE_URL.");
const host = new URL(url).hostname;
const local = host === "127.0.0.1" || host === "localhost" || host === "::1";
const writes = values.apply || values.rollback !== undefined;
if (writes && !local && !values["confirm-production"])
  throw new Error(`${host} is not local: add --confirm-production to write to it.`);

const AFFECTED = `coalesce(last_name_norm, '') = ''
  AND (coalesce(middle_name_norm, '') <> '' OR first_name_norm LIKE '% %')`;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  if (values.rollback !== undefined) await rollback(values.rollback);
  else await repair(values.apply);
} finally {
  await client.end();
}

async function repair(apply: boolean) {
  const before = (
    await client.query<{ n: number; published: number }>(
      `SELECT count(*)::int n, count(*) FILTER (WHERE review_status = 'PUBLISHED')::int published
       FROM unclaimed_folios WHERE ${AFFECTED}`,
    )
  ).rows[0]!;
  console.log(
    `${before.n} records have no last name and a re-splittable name (${before.published} published).`,
  );
  if (!apply) {
    console.log("Dry run: nothing changed. Re-run with --apply to repair.");
    return;
  }
  if (before.n === 0) return;

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = `backup_name_split_${stamp}`;
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TABLE ${backup} AS
       SELECT id, state, ${NAME_COLS.join(", ")} FROM unclaimed_folios WHERE ${AFFECTED}`,
    );
    let changed = 0;
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { rows } = await client.query<{
        id: string;
        state: string;
        first_name_norm: string;
        middle_name_norm: string | null;
        last_name_norm: string | null;
      }>(
        `SELECT id, state, first_name_norm, middle_name_norm, last_name_norm
         FROM ${backup} WHERE id > $1 ORDER BY id LIMIT ${BATCH}`,
        [after],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1]!.id;
      const params: unknown[] = [];
      const tuples = rows.map((r) => {
        const c = folioSearchColumns({
          first: r.first_name_norm,
          middle: r.middle_name_norm,
          last: r.last_name_norm,
        });
        const vals = [
          r.id,
          r.state,
          c.firstNameNorm,
          c.middleNameNorm,
          c.lastNameNorm,
          c.firstNameKey,
          c.middleNameKey,
          c.lastNameKey,
        ];
        const start = params.length;
        params.push(...vals);
        return `(${vals.map((_, i) => `$${start + i + 1}`).join(", ")})`;
      });
      const res = await client.query(
        `UPDATE unclaimed_folios f SET
           first_name_norm = v.fn, middle_name_norm = v.mn, last_name_norm = v.ln,
           first_name_key = v.fk, middle_name_key = v.mk, last_name_key = v.lk,
           updated_at = now()
         FROM (VALUES ${tuples.join(", ")}) AS v(id, state, fn, mn, ln, fk, mk, lk)
         WHERE f.id = v.id::uuid AND f.state::text = v.state`,
        params,
      );
      changed += res.rowCount ?? 0;
    }
    // New spellings join the vocabulary that fuzzy search matches against.
    const words = await client.query(
      `INSERT INTO name_words
       SELECT DISTINCT w FROM (
         SELECT unnest(ARRAY[f.first_name_norm, f.middle_name_norm, f.last_name_norm]) AS w
         FROM unclaimed_folios f JOIN ${backup} b ON b.id = f.id AND b.state = f.state
       ) x WHERE length(w) > 1
       ON CONFLICT DO NOTHING`,
    );
    const left = (
      await client.query<{ n: number }>(
        `SELECT count(*)::int n FROM unclaimed_folios WHERE ${AFFECTED}`,
      )
    ).rows[0]!.n;
    if (left !== 0) throw new Error(`${left} records still lack a last name after the repair.`);
    await client.query("COMMIT");
    await client.query("ANALYZE unclaimed_folios");
    console.log(
      `Repaired ${changed} records; ${words.rowCount ?? 0} new words in the search vocabulary.`,
    );
    console.log(`Backup: ${backup} (undo with --rollback ${backup}).`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function rollback(backup: string) {
  if (!/^backup_name_split_\d{14}$/.test(backup)) throw new Error("Not a name-split backup table.");
  await client.query("BEGIN");
  try {
    const res = await client.query(
      `UPDATE unclaimed_folios f SET
         ${NAME_COLS.map((c) => `${c} = b.${c}`).join(", ")}, updated_at = now()
       FROM ${backup} b WHERE f.id = b.id AND f.state = b.state`,
    );
    await client.query("COMMIT");
    console.log(`Restored ${res.rowCount ?? 0} records from ${backup}.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
