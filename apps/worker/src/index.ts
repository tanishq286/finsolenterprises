import "dotenv/config";
import { PanIndiaHarvester } from "./harvester.js";

async function main() {
  const harvester = new PanIndiaHarvester();
  try {
    const res = await harvester.run({
      limit: 10,
      rowsPerCompany: 1000,
      chunkSize: 5000,
    });
    console.log(`[Worker] Harvest complete: ${res.totalIngested} inserted across ${res.results.length} companies. Memory: ${res.peakMemoryMb}MB.`);
  } finally {
    await harvester.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main().catch((e) => {
    console.error("[Worker] Fatal error:", e);
    process.exit(1);
  });
}

export * from "./harvester.js";
