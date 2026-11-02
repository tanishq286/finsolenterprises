import { Controller, Get } from "@nestjs/common";
import { Prisma } from "@finsol/db";
import { holdingValuePaise, RECOVERABLE_SHARES_SQL } from "@finsol/shared";

import { Public } from "../../common/auth/decorators.js";
import { PrismaService } from "../../common/prisma.service.js";
import { num } from "../../common/serialize.js";

interface Stats {
  /** Searchable holder records (statement entries): not people, not unique folios. */
  folios: number;
  holderRecords: number;
  /** Distinct folio or demat numbers behind those records. */
  distinctFolios: number;
  /** Companies with at least one holder record. */
  companiesWithRecords: number;
  /** Company profiles in the directory, with or without holder records. */
  companies: number;
  companyProfiles: number;
  listedEquities: number;
  states: number;
  /** Published holder records: the headline figure. */
  verifiedRecords: number;
  /**
   * Defensible recoverable value: shareValuePaise + unclaimedAmountsPaise.
   * estimatedValuePaise carries the same figure for older clients.
   */
  recoverableValuePaise: number;
  /** Market value of shares with the IEPF, due for transfer, or in suspense, once per folio. */
  shareValuePaise: number;
  /** Unclaimed dividends and other listed amounts, each listed amount once per folio and event. */
  unclaimedAmountsPaise: number;
  /** Folios whose shares count towards shareValuePaise. */
  shareFolios: number;
  estimatedValuePaise: number;
  activeCases: number;
  creditedCases: number;
  verifiedAssociates: number;
  asOf: string;
}

/** Live counters for the home page. Cached for a minute. */
@Controller("stats")
export class StatsController {
  private cache: { at: number; value: Stats } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async stats(): Promise<Stats> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const db = this.prisma.client;
    const published = { reviewStatus: "PUBLISHED" };
    const [
      folios,
      companies,
      states,
      perCompany,
      activeCases,
      creditedCases,
      verifiedAssociates,
      listedEquities,
      distinct,
    ] = await Promise.all([
      db.unclaimedFolio.count({ where: published }),
      db.company.count(),
      db.unclaimedFolio.groupBy({ by: ["state"], where: published }).then((g) => g.length),
      // Shares count only for share records with the IEPF, due for transfer or in
      // suspense, never the shares behind an unclaimed dividend; a folio listed
      // in several years' statements counts once, at its largest stated holding.
      // Amounts count once per folio, event and amount.
      db.$queryRaw<{ company_id: string; shares: bigint; share_folios: bigint; amount: string }[]>`
          WITH shares AS (
            SELECT f.company_id, f.folio_number_hash, max(f.post_action_shares) AS shares
              FROM unclaimed_folios f
             WHERE f.review_status = 'PUBLISHED' AND ${Prisma.raw(RECOVERABLE_SHARES_SQL)}
             GROUP BY 1, 2),
          amounts AS (
            SELECT DISTINCT f.company_id, f.folio_number_hash, f.event_date,
                   f.transfer_financial_year, f.unclaimed_dividend_amount AS amount
              FROM unclaimed_folios f
             WHERE f.review_status = 'PUBLISHED' AND f.unclaimed_dividend_amount > 0),
          companies AS (
            SELECT DISTINCT company_id FROM unclaimed_folios WHERE review_status = 'PUBLISHED')
          SELECT c.company_id,
                 coalesce((SELECT sum(s.shares) FROM shares s WHERE s.company_id = c.company_id), 0)::bigint AS shares,
                 (SELECT count(*) FROM shares s WHERE s.company_id = c.company_id) AS share_folios,
                 coalesce((SELECT sum(a.amount) FROM amounts a WHERE a.company_id = c.company_id), 0)::text AS amount
            FROM companies c`,
      db.recoveryCase.count({ where: { recoverStep: { lt: 7 } } }),
      db.recoveryCase.count({ where: { dematCreditStatus: "DONE" } }),
      db.associate.count({ where: { isVerified: true } }),
      db.listedEquity.count(),
      db.$queryRaw<{ n: bigint }[]>`
          SELECT count(DISTINCT (company_id, folio_number_hash)) AS n
            FROM unclaimed_folios WHERE review_status = 'PUBLISHED'`,
    ]);
    const prices = new Map(
      (await db.company.findMany({ select: { id: true, currentMarketPrice: true } })).map((c) => [
        c.id,
        num(c.currentMarketPrice),
      ]),
    );
    // Shares are valued only where a price exists; amounts are as the statements list them.
    let shareValuePaise = 0;
    let unclaimedAmountsPaise = 0;
    let shareFolios = 0;
    for (const g of perCompany) {
      shareValuePaise += holdingValuePaise(Number(g.shares), prices.get(g.company_id) ?? 0);
      unclaimedAmountsPaise += Math.round(Number(g.amount) * 100);
      shareFolios += Number(g.share_folios);
    }
    const recoverableValuePaise = shareValuePaise + unclaimedAmountsPaise;
    const value: Stats = {
      folios,
      holderRecords: folios,
      distinctFolios: Number(distinct[0]?.n ?? 0),
      companiesWithRecords: perCompany.length,
      companies,
      companyProfiles: companies,
      listedEquities,
      states,
      verifiedRecords: folios,
      recoverableValuePaise,
      shareValuePaise,
      unclaimedAmountsPaise,
      shareFolios,
      estimatedValuePaise: recoverableValuePaise,
      activeCases,
      creditedCases,
      verifiedAssociates,
      asOf: new Date().toISOString(),
    };
    this.cache = { at: Date.now(), value };
    return value;
  }
}
