#!/usr/bin/env node
// Promotes chosen companies' PUBLISHED folios (with their company row and the
// source documents they came from) from one database to another, re-encrypting
// every folio number under the target's keys. Nothing in the target is updated
// or deleted: rows that already exist are skipped.
//
//   SOURCE_DATABASE_URL=postgresql://…staging…  TARGET_DATABASE_URL=postgresql://…neon (direct)…
//   COMPANY_ISINS=INE406A01037,INE855B01025
//   node --env-file=../../.env.prod.keys scripts/promote-companies.mjs           # dry run
//   node --env-file=../../.env.prod.keys scripts/promote-companies.mjs --apply   # commit
//
// The dry run does the whole promotion inside one transaction, verifies it and
// rolls it back, so it proves the apply will succeed. FOLIO_ENCRYPTION_KEY /
// FOLIO_HASH_KEY are the TARGET keys; SOURCE_FOLIO_* default to the development
// keys the local databases use. Raw source rows (encrypted original cells),
// users, cases, OTPs, audit and ingestion records are never copied.
import { decryptField, encryptField, blindIndex, keysFromEnv } from "../dist/index.js";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const BATCH = 500;
const source = process.env.SOURCE_DATABASE_URL;
const target = process.env.TARGET_DATABASE_URL;
const isins = (process.env.COMPANY_ISINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!source || !target) throw new Error("Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL.");
if (source === target) throw new Error("Source and target are the same database.");
if (!isins.length) throw new Error("Set COMPANY_ISINS (comma-separated).");

const targetKeys = keysFromEnv({ ...process.env, NODE_ENV: "production" });
const sourceKeys = keysFromEnv({
  FOLIO_ENCRYPTION_KEY: process.env.SOURCE_FOLIO_ENCRYPTION_KEY,
  FOLIO_HASH_KEY: process.env.SOURCE_FOLIO_HASH_KEY,
});
if (targetKeys.encryptionKey.equals(sourceKeys.encryptionKey))
  throw new Error("Target keys equal the source keys; set the production FOLIO_* keys.");

const src = new pg.Client({ connectionString: source });
const dst = new pg.Client({ connectionString: target });
await src.connect();
await dst.connect();

/** Stored (non-generated) columns of a table in one database, with json flags. */
async function storedColumns(client, table) {
  const r = await client.query(
    `SELECT a.attname, format_type(a.atttypid, NULL) IN ('json', 'jsonb') AS json
     FROM pg_attribute a
     WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
     ORDER BY a.attnum`,
    [table],
  );
  return r.rows;
}

/** Columns both sides store, and the source columns the target lacks. */
async function sharedColumns(table) {
  const [s, t] = await Promise.all([storedColumns(src, table), storedColumns(dst, table)]);
  const tNames = new Set(t.map((c) => c.attname));
  return {
    cols: s.filter((c) => tNames.has(c.attname)),
    missing: s.filter((c) => !tNames.has(c.attname)).map((c) => c.attname),
  };
}

async function insertRows(table, cols, rows) {
  if (!rows.length) return 0;
  const list = cols.map((c) => `"${c.attname}"`).join(", ");
  const values = [];
  const tuples = rows.map((row) => {
    const start = values.length;
    for (const c of cols) {
      const v = row[c.attname];
      values.push(c.json && v !== null && v !== undefined ? JSON.stringify(v) : v);
    }
    return `(${cols.map((_, i) => `$${start + i + 1}`).join(", ")})`;
  });
  const res = await dst.query(
    `INSERT INTO "${table}" (${list}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
    values,
  );
  return res.rowCount;
}

const report = [];
await dst.query("BEGIN");
try {
  const companyCols = await sharedColumns("companies");
  const docCols = await sharedColumns("source_documents");
  const folioCols = await sharedColumns("unclaimed_folios");
  if (docCols.missing.length || folioCols.missing.length)
    throw new Error(
      `Target schema is behind the source (missing ${[...docCols.missing, ...folioCols.missing].join(", ")}). Run the migrations first.`,
    );

  for (const isin of isins) {
    const sc = (await src.query(`SELECT * FROM companies WHERE isin = $1`, [isin])).rows[0];
    if (!sc) throw new Error(`No company with ISIN ${isin} in the source.`);

    // Company: reuse the target's row for this ISIN, or insert the source row.
    let companyId = (await dst.query(`SELECT id FROM companies WHERE isin = $1`, [isin])).rows[0]
      ?.id;
    let companyInserted = 0;
    if (!companyId) {
      const clash = (
        await dst.query(
          `SELECT id, name FROM companies WHERE id = $1 OR slug = $2 OR (cin IS NOT NULL AND cin = $3)`,
          [sc.id, sc.slug, sc.cin],
        )
      ).rows[0];
      if (clash)
        throw new Error(
          `${sc.name}: target already has ${clash.name} with the same id, slug or CIN.`,
        );
      companyInserted = await insertRows("companies", companyCols.cols, [sc]);
      companyId = sc.id;
    }

    // Source documents behind the published folios, matched on (sha256, parser_version).
    const docs = (
      await src.query(
        `SELECT * FROM source_documents WHERE id IN (
           SELECT DISTINCT source_document_id FROM unclaimed_folios
           WHERE company_id = $1 AND review_status = 'PUBLISHED' AND source_document_id IS NOT NULL)`,
        [sc.id],
      )
    ).rows;
    const docMap = new Map();
    let docsInserted = 0;
    for (const d of docs) {
      const existing = (
        await dst.query(
          `SELECT id FROM source_documents WHERE sha256 = $1 AND parser_version IS NOT DISTINCT FROM $2`,
          [d.sha256, d.parser_version],
        )
      ).rows[0]?.id;
      if (existing) {
        docMap.set(d.id, existing);
        continue;
      }
      docsInserted += await insertRows("source_documents", docCols.cols, [
        { ...d, company_id: companyId, ingestion_job_id: null, reviewed_by_id: null },
      ]);
      docMap.set(d.id, d.id);
    }

    // Published folios, paged by id, re-encrypted under the target keys.
    const expected = (
      await src.query(
        `SELECT count(*)::int n FROM unclaimed_folios WHERE company_id = $1 AND review_status = 'PUBLISHED'`,
        [sc.id],
      )
    ).rows[0].n;
    let after = "00000000-0000-0000-0000-000000000000";
    let foliosInserted = 0;
    for (;;) {
      const { rows } = await src.query(
        `SELECT * FROM unclaimed_folios
         WHERE company_id = $1 AND review_status = 'PUBLISHED' AND id > $2
         ORDER BY id LIMIT ${BATCH}`,
        [sc.id, after],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const out = rows.map((r) => {
        const plain = decryptField(r.folio_number, sourceKeys);
        return {
          ...r,
          company_id: companyId,
          folio_number: encryptField(plain, targetKeys),
          folio_number_hash: blindIndex(plain, targetKeys),
          ingestion_job_id: null,
          source_document_id: r.source_document_id
            ? (docMap.get(r.source_document_id) ?? null)
            : null,
        };
      });
      foliosInserted += await insertRows("unclaimed_folios", folioCols.cols, out);
    }

    // Verify: every published folio is present and decrypts under the target keys.
    const present = (
      await dst.query(
        `SELECT count(*)::int n FROM unclaimed_folios WHERE company_id = $1 AND review_status = 'PUBLISHED'`,
        [companyId],
      )
    ).rows[0].n;
    if (present < expected)
      throw new Error(`${sc.name}: target has ${present} published folios, expected ${expected}.`);
    const samples = await dst.query(
      `SELECT folio_number, folio_number_hash FROM unclaimed_folios WHERE company_id = $1 ORDER BY random() LIMIT 5`,
      [companyId],
    );
    for (const s of samples.rows)
      if (blindIndex(decryptField(s.folio_number, targetKeys), targetKeys) !== s.folio_number_hash)
        throw new Error(`${sc.name}: blind index mismatch after re-encryption.`);
    report.push({
      company: sc.name,
      isin,
      companyInserted,
      docs: docs.length,
      docsInserted,
      published: expected,
      foliosInserted,
      present,
    });
  }

  // New spellings join the vocabulary that fuzzy search matches against.
  const words = await dst.query(
    `INSERT INTO name_words
     SELECT DISTINCT w FROM (
       SELECT unnest(ARRAY[f.first_name_norm, f.middle_name_norm, f.last_name_norm]) AS w
       FROM unclaimed_folios f JOIN companies c ON c.id = f.company_id
       WHERE c.isin = ANY($1)
     ) x WHERE length(w) > 1
     ON CONFLICT DO NOTHING`,
    [isins],
  );
  const totals = (
    await dst.query(
      `SELECT count(*)::int total, count(*) FILTER (WHERE review_status = 'PUBLISHED')::int published FROM unclaimed_folios`,
    )
  ).rows[0];

  console.table(report);
  console.log(`name_words added: ${words.rowCount}`);
  console.log(`target folios now: ${totals.total} (${totals.published} published)`);
  if (APPLY) {
    await dst.query("COMMIT");
    await dst.query("ANALYZE unclaimed_folios");
    await dst.query("ANALYZE name_words");
    console.log("Committed.");
  } else {
    await dst.query("ROLLBACK");
    console.log("Dry run: rolled back. Re-run with --apply to commit.");
  }
} catch (err) {
  await dst.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await src.end();
  await dst.end();
}
