import "dotenv/config";
import { parseArgs } from "node:util";
import { PanIndiaHarvester } from "../apps/worker/dist/harvester.js";

async function main() {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", short: "l", default: "5" },
      rows: { type: "string", short: "r", default: "1000" },
      chunk: { type: "string", short: "c", default: "5000" },
      rta: { type: "string", default: "ALL" },
      query: { type: "string", short: "q" },
      "dry-run": { type: "boolean", default: false },
      rollback: { type: "string" },
    },
  });

  const harvester = new PanIndiaHarvester();

  try {
    if (values.rollback) {
      console.log(`\n========================================`);
      console.log(`PAN-INDIA ROLLBACK ENGINE`);
      console.log(`========================================`);
      console.log(`Rolling back batchRunId: ${values.rollback}`);
      const res = await harvester.rollback(values.rollback);
      console.log(`[Success] Deleted ${res.deletedCount} folios associated with batch.`);
      return;
    }

    const limit = parseInt(values.limit ?? "5", 10);
    const rowsPerCompany = parseInt(values.rows ?? "1000", 10);
    const chunkSize = parseInt(values.chunk ?? "5000", 10);
    const dryRun = values["dry-run"] ?? false;
    const rtaArg = values.rta?.toUpperCase();
    const rta =
      rtaArg === "KFINTECH"
        ? "KFINTECH"
        : rtaArg === "LINK_INTIME"
          ? "LINK_INTIME"
          : rtaArg === "OTHER"
            ? "OTHER"
            : "ALL";

    console.log(`\n======================================================`);
    console.log(`PAN-INDIA IEPF-2 BULK INGESTION HARVESTER`);
    console.log(`======================================================`);
    console.log(`Target Limit:        ${limit} companies`);
    console.log(`Rows Per Company:    ${rowsPerCompany}`);
    console.log(`Streaming Chunk:     ${chunkSize} rows`);
    console.log(`RTA Scope:           ${rta}`);
    console.log(`Execution Mode:      ${dryRun ? "DRY RUN (No DB Writes)" : "LIVE INGESTION (COPY + Merge)"}`);
    console.log(`------------------------------------------------------\n`);

    const result = await harvester.run({
      limit,
      rowsPerCompany,
      chunkSize,
      rta,
      query: values.query,
      dryRun,
    });

    console.log(`\n======================================================`);
    console.log(`BATCH INGESTION RESULTS`);
    console.log(`======================================================`);
    console.table(
      result.results.map((r) => ({
        Company: r.sourceCompany.slice(0, 25),
        RTA: r.sourceRta,
        BatchId: r.batchRunId.slice(0, 8),
        TotalRows: r.totalRows,
        Valid: r.validRows,
        Quarantine: r.quarantinedRows,
        Inserted: r.insertedRows,
        Updated: r.updatedRows,
        Shares: r.totalShares,
        Amount: `₹${r.totalAmountRupees}`,
        PeakHeap: `${r.peakMemoryMb} MB`,
        Duration: `${r.durationMs}ms`,
        Status: r.status,
      })),
    );

    console.log(`------------------------------------------------------`);
    console.log(`Total Companies:     ${result.results.length}`);
    console.log(`Total Ingested:      ${result.totalIngested} folios`);
    console.log(`Total Valid:         ${result.totalValid}`);
    console.log(`Total Quarantined:   ${result.totalQuarantined}`);
    console.log(`Peak Memory:         ${result.peakMemoryMb} MB (Flat Streaming Heap)`);
    console.log(`Total Time:          ${result.durationMs} ms`);
    console.log(`======================================================\n`);
  } finally {
    await harvester.close();
  }
}

main().catch((err) => {
  console.error("Pan-India Ingestion Failed:", err);
  process.exit(1);
});
