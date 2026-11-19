import { createHmac } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import type { IndianState, SearchDemandReport } from "@finsol/shared";

import { PrismaService } from "../../common/prisma.service.js";

/** Domain label for the key, so these hashes never equal a folio blind index. */
const KEY_LABEL = "search-demand-v1";
const HASH_BYTES = 16;
/** A zero-result search waits at most this long for its log row; then it answers anyway. */
export const RECORD_TIMEOUT_MS = 250;
export const RETENTION_DAYS = 90;
/** About 9 MB at ~120 bytes a row: the hard ceiling on Neon's 1 GB plan. */
export const MAX_ROWS = 75_000;
const TOP = 50;

export interface DemandEntry {
  mode: "name" | "company_folio";
  /** Already normalized; null in name mode. */
  companyQuery: string | null;
  companyKnown: boolean;
  /** null is All India. */
  state: IndianState | null;
  /** What identifies the searcher's question: normalized name, or company + folio. Hashed, never stored. */
  material: string;
  resultCount: number;
}

interface CountRow {
  key: string | null;
  searches: number;
  searchers: number;
}

@Injectable()
export class SearchDemandService {
  private readonly log = new Logger(SearchDemandService.name);
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService) {
    this.key = createHmac("sha256", prisma.fieldKeys.hashKey).update(KEY_LABEL).digest();
  }

  /** Truncated keyed hash: counts repeat searchers without keeping what they typed. */
  hash(material: string): Buffer {
    return createHmac("sha256", this.key).update(material).digest().subarray(0, HASH_BYTES);
  }

  /**
   * Logs one zero-result search. Never throws and never holds the search up
   * for more than RECORD_TIMEOUT_MS: demand counts are not worth a failed search.
   */
  async record(entry: DemandEntry): Promise<void> {
    let insert: Promise<void>;
    try {
      insert = this.prisma.client.$executeRaw`INSERT INTO search_demand_log
            (search_mode, company_query, company_known, state, name_hash, result_count)
          VALUES (${entry.mode}, ${entry.companyQuery}, ${entry.companyKnown},
                  ${entry.state}::"IndianState", ${this.hash(entry.material)},
                  ${Math.min(entry.resultCount, 32_767)})`.then(() => undefined);
    } catch (e: unknown) {
      insert = Promise.reject(e);
    }
    const logged = insert.catch((e: unknown) => {
      this.log.warn(`Demand log skipped: ${e instanceof Error ? e.message : String(e)}`);
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((done) => {
      timer = setTimeout(done, RECORD_TIMEOUT_MS);
    });
    await Promise.race([logged, timeout]);
    clearTimeout(timer);
  }

  /** Staff report over the last `days` days. */
  async report(days: number): Promise<SearchDemandReport> {
    const since = new Date(Date.now() - days * 86_400_000);
    const db = this.prisma.client;
    const companies = (known: boolean) => db.$queryRaw<CountRow[]>`
      SELECT company_query AS key, count(*)::int AS searches, count(DISTINCT name_hash)::int AS searchers
        FROM search_demand_log
       WHERE created_at >= ${since} AND search_mode = 'company_folio'
         AND company_known = ${known} AND company_query IS NOT NULL
       GROUP BY company_query ORDER BY searches DESC, searchers DESC LIMIT ${TOP}`;
    const [uncovered, covered, byState, total] = await Promise.all([
      companies(false),
      companies(true),
      db.$queryRaw<CountRow[]>`
        SELECT state::text AS key, count(*)::int AS searches, count(DISTINCT name_hash)::int AS searchers
          FROM search_demand_log WHERE created_at >= ${since}
         GROUP BY state ORDER BY searches DESC LIMIT ${TOP}`,
      db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_demand_log WHERE created_at >= ${since}`,
    ]);
    const companyRows = (rows: CountRow[]) =>
      rows.map((r) => ({ companyQuery: r.key!, searches: r.searches, searchers: r.searchers }));
    return {
      days,
      since: since.toISOString(),
      zeroResultSearches: total[0]?.n ?? 0,
      uncoveredCompanies: companyRows(uncovered),
      coveredCompaniesMissingFolio: companyRows(covered),
      byState: byState.map((r) => ({
        state: r.key as IndianState | null,
        searches: r.searches,
        searchers: r.searchers,
      })),
    };
  }

  /** Daily: drop rows past retention, then keep only the newest MAX_ROWS. */
  async prune(): Promise<{ expired: number; overCap: number }> {
    const db = this.prisma.client;
    const expired = await db.$executeRaw`
      DELETE FROM search_demand_log WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS}::int)`;
    const overCap = await db.$executeRaw`
      DELETE FROM search_demand_log WHERE id < (
        SELECT id FROM search_demand_log ORDER BY id DESC OFFSET ${MAX_ROWS - 1} LIMIT 1)`;
    return { expired, overCap };
  }
}
