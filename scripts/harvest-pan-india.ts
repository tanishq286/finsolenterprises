/**
 * Pan-India IEPF harvester.
 *
 *   npm run ingest:pan-india -- files [--dir data/pan-india-drop] [--only a.xlsx,b.pdf] [--chunk 5000] [--dry-run]
 *       Streams the statements listed in <dir>/manifest.json into the state partitions.
 *       Each file is one batch (an ingestion job id stamped on every record it writes).
 *   npm run ingest:pan-india -- discover --rta kfintech|link_intime|priority[,...] [--limit N] [--query text] [--enqueue]
 *       Lists issuers from the source register (by registrar or priority list) and, with
 *       --enqueue, queues discovery of the statements on each issuer's own website for
 *       `npm run acquire -w @finsol/db -- work`.
 *   npm run ingest:pan-india -- rollback <batchRunId>
 *       Deletes the holder records that batch created; records it only updated are kept for review.
 *
 * Nothing here generates records. Writes go to DATABASE_URL (default: the local
 * development database); a non-local database needs --confirm-production.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { PanIndiaHarvester, type AdapterId } from "../apps/worker/dist/harvester.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: "data/pan-india-drop" },
    only: { type: "string" },
    chunk: { type: "string", default: "5000" },
    "dry-run": { type: "boolean", default: false },
    rta: { type: "string", default: "priority" },
    limit: { type: "string" },
    query: { type: "string", short: "q" },
    enqueue: { type: "boolean", default: false },
    "confirm-production": { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

const url = process.env.DATABASE_URL;
const local = !url || /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
const command = positionals[0];
if (!command || !["files", "discover", "rollback"].includes(command))
  fail(
    "Usage: ingest:pan-india -- files | discover | rollback <batchRunId>  (see scripts/harvest-pan-india.ts)",
  );
if (!local && !values["confirm-production"] && !(command === "files" && values["dry-run"]))
  fail(
    "DATABASE_URL is not a local database. Pass --confirm-production only with written approval.",
  );

const chunk = Number(values.chunk);
if (!Number.isInteger(chunk) || chunk < 100 || chunk > 100_000)
  fail("--chunk must be 100 to 100000.");

const harvester = new PanIndiaHarvester();
try {
  if (command === "rollback") {
    const id = positionals[1] ?? fail("Pass the batchRunId to roll back.");
    const r = await harvester.rollback(id);
    console.log(
      `Rolled back ${id}: ${r.deleted} records deleted, ${r.keptForReview} pre-existing records kept for review, ${r.dividendEventsRemoved} dividend events removed.`,
    );
  } else if (command === "discover") {
    const ids = values.rta.split(",").map((s) => s.trim().toLowerCase()) as AdapterId[];
    if (ids.some((i) => !["kfintech", "link_intime", "priority"].includes(i)))
      fail("--rta takes kfintech, link_intime and/or priority.");
    const limit = values.limit ? Number(values.limit) : undefined;
    const out = await harvester.discover({
      adapters: ids,
      limit,
      query: values.query,
      enqueue: values.enqueue,
    });
    for (const o of out) {
      console.log(
        `\n${o.adapter}: ${o.targets.length} issuers in the register${values.enqueue ? `, ${o.queued} queued for discovery` : ""}`,
      );
      console.table(
        o.targets.slice(0, 25).map((t) => ({
          Symbol: t.nseSymbol ?? "",
          Name: t.name.slice(0, 40),
          Registrar: (t.registrar ?? "not recorded").slice(0, 30),
          "IR page": t.irUrl ? "yes" : t.website ? "website only" : "none",
        })),
      );
    }
    if (out.every((o) => o.targets.length === 0))
      console.log(
        "\nThe register has no matching issuers. Load it first: npm run acquire -w @finsol/db -- universe",
      );
  } else {
    const dir = resolve(values.dir);
    const results = await harvester.files(
      dir,
      { dryRun: values["dry-run"], chunkSize: chunk, only: values.only?.split(",") },
      (file, i) =>
        console.log(
          `  ${file}: chunk ${i.chunk}, ${i.rowsRead} rows read, RSS ${i.rssMb} MB, heap ${i.heapMb} MB`,
        ),
    );
    console.table(
      results.map((r) => ({
        File: r.file.slice(0, 34),
        Company: r.company,
        Batch: r.batchRunId?.slice(0, 8) ?? "",
        Status: r.status,
        Rows: r.totalRows,
        Valid: r.validRows,
        Warning: r.warningRows,
        Quarantined: r.quarantinedRows,
        Inserted: r.insertedRows,
        Updated: r.updatedRows,
        "Amount ₹": r.amountTotal,
        Chunks: r.chunks,
        "Peak RSS MB": r.peakRssMb,
        "Peak heap MB": r.peakHeapMb,
        "Time ms": r.durationMs,
      })),
    );
    for (const r of results) if (r.detail) console.log(`${r.file}: ${r.detail}`);
    if (results.some((r) => r.status === "FAILED")) process.exitCode = 1;
  }
} finally {
  await harvester.close();
}
