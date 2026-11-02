import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export * from "./generated/prisma/client.js";
export * from "./crypto.js";
export * from "./columns.js";
export * from "./ingest-iepf.js";
export * from "./bulk-copy.js";
export * from "./market-sources.js";

import { LOCAL_DATABASE_URL } from "./local-url.js";

export { LOCAL_DATABASE_URL };

export function createPrismaClient(
  url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
export * from "./statement-links.js";
export { fetchBuffer, robotsAllows, sleep, USER_AGENT } from "./http.js";
export { DROP_DIR, detectKind, processFile } from "./ingest-pan-india.js";
export * from "./pan-india/index.js";
export * from "./stream-ingest.js";
export { openStatementStream, STREAM_PARSER_VERSION } from "./stream-reader.js";
