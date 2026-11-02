#!/usr/bin/env node
// Logical backup without pg_dump: every table in the public schema is streamed
// out with COPY … TO STDOUT as CSV, next to a manifest of row counts and the
// applied migrations. Partitioned tables are exported through their parent, so
// each row appears once. Folio numbers stay encrypted (they are ciphertext in
// the database); the files still hold names and addresses, so keep the folder
// private and outside the repository.
//
//   DATABASE_URL=postgresql://…  node scripts/backup-database.mjs ~/finsol-backups/2026-11-02-prod
//
// Restore: the schema comes from `prisma migrate deploy` at the manifest's last
// migration; then COPY each CSV back in FROM STDIN (CSV, HEADER).
import { createWriteStream, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import copyStreams from "pg-copy-streams";

const url = process.env.DATABASE_URL;
const out = process.argv[2];
if (!url) throw new Error("Set DATABASE_URL.");
if (!out) throw new Error("Usage: backup-database.mjs <output directory>");
mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);

const client = new pg.Client({ connectionString: url });
await client.connect();
// One consistent snapshot for every table.
await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

const tables = (
  await client.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
     ORDER BY c.relname`,
  )
).rows.map((r) => r.relname);

const counts = {};
for (const table of tables) {
  const file = join(out, `${table}.csv`);
  await pipeline(
    client.query(
      copyStreams.to(`COPY (SELECT * FROM "${table}") TO STDOUT WITH (FORMAT csv, HEADER)`),
    ),
    createWriteStream(file, { mode: 0o600 }),
  );
  counts[table] = (await client.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n;
  console.log(`${table.padEnd(28)} ${String(counts[table]).padStart(8)}`);
}
const migrations = (
  await client.query(
    `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`,
  )
).rows.map((r) => r.migration_name);
await client.query("COMMIT");
const { host, pathname } = new URL(url);
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      database: `${host}${pathname}`,
      migrations,
      tables: counts,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await client.end();
console.log(`Backup of ${tables.length} tables written to ${out}`);
