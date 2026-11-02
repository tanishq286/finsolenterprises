import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { decryptField, type Prisma } from "@finsol/db";
import type { CustodyStatus, FolioState } from "@finsol/shared";
import type pg from "pg";
import {
  countsShareValue,
  holdingValuePaise,
  maskCompanyName,
  maskPincode,
  expandSingleWord,
  resolveSearch,
  STAFF_ROLES,
  VALUATION_BASIS,
  type ClaimRequestBody,
  type ClaimResponse,
  type ResultAccess,
  type SearchCoverage,
  type SearchInput,
  type SearchResponse,
  type SearchResultItem,
} from "@finsol/shared";

import { ENV, type Env } from "../../config/env.js";
import { AuditService } from "../../common/audit.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { JobQueueService } from "../../common/queue/job-queue.service.js";
import { num } from "../../common/serialize.js";
import { competingClaims, isContested, lockFolios } from "../../common/claims.js";
import { LiveMcaSyncService } from "./live-mca-sync.service.js";
import { SEARCH_ENGINE, SEARCH_POOL } from "./search.tokens.js";
import type { SearchEngine, SearchHit } from "./search-engine.js";

type FolioWithCompany = Prisma.UnclaimedFolioGetPayload<{ include: { company: true } }>;

const RESULT_LIMIT = 50;

/** Exactly the columns a search result needs, one row per matched folio. */
interface ResultRow {
  id: string;
  state: FolioState;
  investor_full_name: string;
  father_or_spouse_name: string | null;
  city: string | null;
  pincode: string | null;
  investor_cluster_id: string;
  custody_status: CustodyStatus;
  folio_number: string;
  folio_number_masked: string;
  post_action_shares: number;
  original_shares: number;
  dividend_rupees: number;
  source_published_at: Date | null;
  source_retrieved_at: Date | null;
  event_date: string | null;
  investment_type: string | null;
  transfer_financial_year: string | null;
  company_name: string;
  company_slug: string;
  price_rupees: number | null;
  price_updated_at: Date | null;
}

const RESULT_COLUMNS = `
  f.id, f.state::text AS state, f.investor_full_name, f.father_or_spouse_name, f.city, f.pincode,
  f.investor_cluster_id, f.custody_status::text AS custody_status, f.folio_number,
  f.folio_number_masked, f.post_action_shares, f.original_shares,
  f.unclaimed_dividend_amount::float8 AS dividend_rupees,
  to_char(f.event_date, 'YYYY-MM-DD') AS event_date, f.investment_type, f.transfer_financial_year,
  c.name AS company_name, c.slug AS company_slug,
  c.current_market_price::float8 AS price_rupees, c.price_updated_at,
  d.published_at AS source_published_at, d.retrieved_at AS source_retrieved_at
FROM unclaimed_folios f JOIN companies c ON c.id = f.company_id
LEFT JOIN source_documents d ON d.id = f.source_document_id`;
/** Quarantined and withdrawn records are never returned: they wait for, or failed, review. */
const PUBLISHED = `f.review_status = 'PUBLISHED'`;
/** Pruned to the matched states at run time; Meilisearch hits carry no state. */
export const RESULTS_BY_STATE = {
  name: "search_results_by_state_v2",
  text: `SELECT ${RESULT_COLUMNS} WHERE f.state = ANY($2::"IndianState"[]) AND f.id = ANY($1::uuid[]) AND ${PUBLISHED}`,
};
export const RESULTS_BY_ID = {
  name: "search_results_by_id_v2",
  text: `SELECT ${RESULT_COLUMNS} WHERE f.id = ANY($1::uuid[]) AND ${PUBLISHED}`,
};

const COVERAGE_TTL_MS = 10 * 60_000;

/** Masked company names, computed once per company rather than once per row. */
const maskedNames = new Map<string, string>();
function maskedCompany(name: string): string {
  let m = maskedNames.get(name);
  if (m === undefined) {
    if (maskedNames.size > 20_000) maskedNames.clear();
    m = maskCompanyName(name);
    maskedNames.set(name, m);
  }
  return m;
}

const MAX_CLAIM_FOLIOS = 10;

export function estimateValuePaise(f: FolioWithCompany): number {
  return (
    (countsShareValue({
      custodyStatus: f.custodyStatus,
      investmentType: f.investmentType,
      shares: f.postActionShares,
    })
      ? holdingValuePaise(f.postActionShares, num(f.company.currentMarketPrice))
      : 0) + Math.round(num(f.unclaimedDividendAmount) * 100)
  );
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveMcaSyncService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEngine,
    @Inject(SEARCH_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private coverageCache: { at: number; value: SearchCoverage } | null = null;

  /** What the search covers, cached briefly per instance. Aggregates only. */
  async coverage(): Promise<SearchCoverage> {
    if (this.coverageCache && Date.now() - this.coverageCache.at < COVERAGE_TTL_MS)
      return this.coverageCache.value;
    const db = this.prisma.client;
    const [perCompany, profiles, equities, sources, years] = await Promise.all([
      db.$queryRaw<{ name: string; records: bigint }[]>`
        SELECT c.name, count(*) AS records FROM unclaimed_folios f
          JOIN companies c ON c.id = f.company_id
         WHERE f.review_status = 'PUBLISHED'
         GROUP BY c.name ORDER BY count(*) DESC`,
      db.company.count(),
      db.listedEquity.count(),
      db.sourceDocument.aggregate({
        where: { status: "IMPORTED" },
        _max: { publishedAt: true, retrievedAt: true },
      }),
      db.$queryRaw<{ oldest: number | null; newest: number | null }[]>`
        SELECT min(extract(year FROM event_date))::int AS oldest,
               max(extract(year FROM event_date))::int AS newest
          FROM unclaimed_folios WHERE review_status = 'PUBLISHED'`,
    ]);
    const companiesWithRecords = perCompany.map((c) => ({
      name: c.name,
      records: Number(c.records),
    }));
    const value: SearchCoverage = {
      holderRecords: companiesWithRecords.reduce((a, c) => a + c.records, 0),
      companiesWithRecords,
      companiesWithRecordsCount: companiesWithRecords.length,
      companyProfiles: profiles,
      listedEquities: equities,
      latestSourcePublishedAt: sources._max.publishedAt?.toISOString() ?? null,
      latestSourceRetrievedAt: sources._max.retrievedAt?.toISOString() ?? null,
      oldestRecordYear: years[0]?.oldest ?? null,
      newestRecordYear: years[0]?.newest ?? null,
    };
    this.coverageCache = { at: Date.now(), value };
    return value;
  }

  private item(
    f: ResultRow,
    hit: SearchHit,
    access: ResultAccess,
    released: Set<string>,
    matchedHolder: "primary" | "joint",
    mode: SearchResponse["mode"],
  ): SearchResultItem {
    const open = access !== "public";
    const folioReleased = access === "staff" || released.has(f.id);
    const dividendPaise = Math.round(f.dividend_rupees * 100);
    // A statement that lists only an amount states no share count: unknown, not zero.
    const sharesStated = f.original_shares > 0;
    // Only shares with the IEPF, due for transfer or in suspense are unclaimed;
    // the shares behind an unclaimed dividend still belong to the holder.
    const shareValue = countsShareValue({
      custodyStatus: f.custody_status,
      investmentType: f.investment_type,
      shares: f.post_action_shares,
    });
    return {
      id: f.id,
      access,
      investorFullName: f.investor_full_name,
      fatherOrSpouseName: f.father_or_spouse_name,
      city: f.city,
      pincodeMasked: maskPincode(f.pincode),
      investorClusterId: f.investor_cluster_id,
      state: f.state,
      custodyStatus: f.custody_status,
      companyName: open ? f.company_name : maskedCompany(f.company_name),
      companySlug: open ? f.company_slug : null,
      // Ciphertext is decrypted only for a row this viewer may see.
      folioNumber: folioReleased
        ? decryptField(f.folio_number, this.prisma.fieldKeys)
        : f.folio_number_masked,
      folioReleased,
      postActionShares: open && sharesStated ? f.post_action_shares : null,
      sharesStated,
      recordKind: shareValue ? "SHARES" : "UNCLAIMED_AMOUNT",
      estimatedTotalValuePaise:
        open && shareValue && f.price_rupees !== null
          ? holdingValuePaise(f.post_action_shares, f.price_rupees) + dividendPaise
          : null,
      sharePricePaise: open && f.price_rupees !== null ? Math.round(f.price_rupees * 100) : null,
      priceUpdatedAt: open && f.price_updated_at ? f.price_updated_at.toISOString() : null,
      unclaimedDividendPaise: open ? dividendPaise : null,
      eventDate: f.event_date,
      investmentType: f.investment_type,
      transferFinancialYear: f.transfer_financial_year,
      matchedHolder,
      matchScore: hit.score,
      matchedBy: hit.matchedBy,
      matchClass: hit.matchedBy !== "exact" ? "variant" : mode === "FULL" ? "exact" : "partial",
      source:
        f.source_published_at || f.source_retrieved_at
          ? {
              publishedAt: f.source_published_at?.toISOString() ?? null,
              retrievedAt: f.source_retrieved_at?.toISOString() ?? null,
            }
          : null,
    };
  }

  /** Folio ids released to this person: by an analyst, or by a signed mandate. */
  private async releasedFor(userId: string): Promise<Set<string>> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (!user) return new Set();
    const [leads, cases] = await Promise.all([
      this.prisma.client.leadInquiry.findMany({
        where: { phone: user.phone },
        select: { releasedFolioIds: true },
      }),
      // Released on a case: by an analyst, or by signing the Digital Mandate.
      this.prisma.client.recoveryCase.findMany({
        where: { clientUserId: userId, folioReleasedAt: { not: null }, folioId: { not: null } },
        select: { folioId: true },
      }),
    ]);
    return new Set([...leads.flatMap((l) => l.releasedFolioIds), ...cases.map((c) => c.folioId!)]);
  }

  /**
   * The 3-Minute Check. Everyone sees who matched and where; signed-in
   * members also see the company, shares and value; folio numbers stay
   * masked until an analyst releases them. Staff see everything.
   */
  async search(
    input: SearchInput,
    viewer: { user?: SessionClaims | null; ip?: string | null },
  ): Promise<SearchResponse> {
    const started = performance.now();
    const q = resolveSearch(input);
    if (!q) throw new BadRequestException("Enter the investor's name.");
    const joint = input.jointHolderName
      ? resolveSearch({ fullName: input.jointHolderName, state: input.state })
      : null;
    const user = viewer.user ?? null;
    const access: ResultAccess = !user
      ? "public"
      : (STAFF_ROLES as readonly string[]).includes(user.role)
        ? "staff"
        : "member";

    if (access === "member") {
      const today = await this.prisma.client.auditEvent.count({
        where: {
          actorId: user!.sub,
          action: "search.member",
          createdAt: { gte: new Date(Date.now() - 86_400_000) },
        },
      });
      if (today >= this.env.MEMBER_SEARCHES_PER_DAY)
        throw new HttpException(
          "You have run the most checks allowed today. Your analyst will continue from here.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    // One more than the limit, to know whether the list was cut short. A single
    // typed word is searched as surname, first and middle name.
    const searchAll = async (r: typeof q) => {
      const lists = await Promise.all(
        expandSingleWord(r).map((x) => this.engine.search(x, RESULT_LIMIT + 1)),
      );
      const best = new Map<string, SearchHit>();
      for (const h of lists.flat()) {
        const seen = best.get(h.id);
        if (!seen || h.score > seen.score) best.set(h.id, h);
      }
      return [...best.values()].sort((a, b) => b.score - a.score);
    };
    const [primaryHits, jointHits, coverage] = await Promise.all([
      searchAll(q),
      joint ? searchAll(joint) : Promise.resolve([]),
      this.coverage(),
    ]);
    const hits = new Map<string, { hit: SearchHit; holder: "primary" | "joint" }>();
    for (const h of primaryHits) hits.set(h.id, { hit: h, holder: "primary" });
    for (const h of jointHits) if (!hits.has(h.id)) hits.set(h.id, { hit: h, holder: "joint" });

    const matched = [...hits.values()].map((h) => h.hit);
    const ids = matched.map((h) => h.id);
    const states = [...new Set(matched.map((h) => h.state))];
    const folios = ids.length
      ? (
          await this.pool.query<ResultRow>(
            states.every(Boolean)
              ? { ...RESULTS_BY_STATE, values: [ids, states] }
              : { ...RESULTS_BY_ID, values: [ids] },
          )
        ).rows
      : [];
    const byId = new Map(folios.map((f) => [f.id, f]));
    const released = access === "member" ? await this.releasedFor(user!.sub) : new Set<string>();
    const all = [...hits.values()].flatMap(({ hit, holder }) => {
      const f = byId.get(hit.id);
      return f ? [this.item(f, hit, access, released, holder, q.mode)] : [];
    });
    const truncated =
      all.length > RESULT_LIMIT ||
      primaryHits.length > RESULT_LIMIT ||
      jointHits.length > RESULT_LIMIT;
    const results = all.slice(0, RESULT_LIMIT);
    if (access === "member")
      await this.audit.record({
        actorId: user!.sub,
        actorRole: user!.role,
        action: "search.member",
        entityType: "search",
        entityId: null,
        data: { state: q.state, matches: results.length, joint: !!joint },
        ip: viewer.ip ?? null,
      });
    return {
      mode: q.mode,
      query: {
        first: q.first,
        middle: q.middle,
        last: q.last,
        state: q.state,
        jointHolder: joint ? [joint.first, joint.middle, joint.last].filter(Boolean).join(" ") : "",
      },
      access,
      total: results.length,
      results,
      limit: RESULT_LIMIT,
      truncated,
      // Company names stay masked for the public, so the coverage gives only a count.
      coverage: access === "public" ? { ...coverage, companiesWithRecords: [] } : coverage,
      valuationBasis: VALUATION_BASIS,
      engine: this.engine.name,
      tookMs: Math.round(performance.now() - started),
      liveRefreshId: this.live.trigger(q.state),
    };
  }

  /** A signed-in member asks Finsol to take up the holdings they picked. */
  async claim(
    body: ClaimRequestBody,
    claims: SessionClaims,
    ip: string | null,
  ): Promise<ClaimResponse> {
    const folioIds = [...new Set(body.folioIds)];
    if (!folioIds.length || folioIds.length > MAX_CLAIM_FOLIOS)
      throw new BadRequestException(`Choose between 1 and ${MAX_CLAIM_FOLIOS} holdings.`);
    const db = this.prisma.client;
    const user = await db.user.findUniqueOrThrow({ where: { id: claims.sub } });
    const folios = await db.unclaimedFolio.findMany({
      where: { id: { in: folioIds } },
      include: { company: true },
    });
    if (folios.length !== folioIds.length)
      throw new BadRequestException("Some of those holdings no longer exist. Run the check again.");

    const associate = body.referralCode
      ? await db.associate.findUnique({
          where: { referralCode: body.referralCode.trim().toUpperCase() },
          select: { id: true },
        })
      : null;
    const estimate = folios.reduce((s, f) => s + estimateValuePaise(f), 0);
    const now = new Date();
    const analyst = await this.pickAnalyst();
    // One transaction, with the records locked: two people claiming the same
    // record at once both end up in review instead of both slipping through.
    const { lead, contest, reviewAlert } = await db.$transaction(async (tx) => {
      await lockFolios(tx, folioIds);
      const contest = await competingClaims(tx, folioIds, user.phone);
      const reviewAlert = isContested(contest) ? ("DUPLICATE_CLAIMANT_REVIEW" as const) : null;
      const existing = await tx.leadInquiry.findFirst({
        where: {
          phone: user.phone,
          crmStage: { not: "CONVERTED_TO_CASE" },
          createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        orderBy: { createdAt: "desc" },
      });
      const lead = existing
        ? await tx.leadInquiry.update({
            where: { id: existing.id },
            data: {
              claimantName: user.name,
              email: user.email ?? existing.email,
              relationshipToHolder: body.relationshipToHolder,
              physicalCertStatus: body.physicalCertStatus,
              phoneOtpVerified: true,
              matchedFolioIds: [...new Set([...existing.matchedFolioIds, ...folioIds])],
              unlockedAt: now,
              estimatedValuePaise: BigInt(Math.max(Number(existing.estimatedValuePaise), estimate)),
              associateId: existing.associateId ?? associate?.id ?? null,
              reviewAlert: reviewAlert ?? existing.reviewAlert,
            },
          })
        : await tx.leadInquiry.create({
            data: {
              claimantName: user.name,
              phone: user.phone,
              phoneOtpVerified: true,
              email: user.email,
              relationshipToHolder: body.relationshipToHolder,
              physicalCertStatus: body.physicalCertStatus,
              matchedFolioIds: folioIds,
              unlockedAt: now,
              assignedAnalystId: analyst,
              estimatedValuePaise: BigInt(estimate),
              associateId: associate?.id ?? null,
              reviewAlert,
              searchContext: {
                folios: folios.map((f) => ({ last: f.lastNameNorm, state: f.state })),
              },
            },
          });
      if (reviewAlert) {
        // The earlier claimants' requests enter review too; nobody is told who else asked.
        await tx.leadInquiry.updateMany({
          where: {
            OR: [
              { id: { in: contest.leads.map((l) => l.id) } },
              { convertedCaseId: { in: contest.cases.map((c) => c.id) } },
            ],
          },
          data: { reviewAlert },
        });
      }
      return { lead, contest, reviewAlert };
    });
    const contestedCases = contest.cases;
    const contestedLeads = contest.leads;
    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: "search.claim",
      entityType: "lead",
      entityId: lead.id,
      data: { folioIds, relationship: body.relationshipToHolder },
      ip,
    });
    if (reviewAlert)
      await this.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: "lead.duplicate_claimant",
        entityType: "lead",
        entityId: lead.id,
        data: {
          folioIds,
          otherCases: contestedCases.map((c) => c.caseCode),
          otherLeads: contestedLeads.map((l) => l.id),
        },
        ip,
      });
    await this.jobs.enqueue("lead.notify-analyst", { leadId: lead.id });
    return {
      leadId: lead.id,
      folioCount: lead.matchedFolioIds.length,
      underReview: !!lead.reviewAlert,
    };
  }

  /** The valuation analyst with the fewest open leads. */
  private async pickAnalyst(): Promise<string | null> {
    const analysts = await this.prisma.client.user.findMany({
      where: { role: "VALUATION_ANALYST", isActive: true },
      select: {
        id: true,
        _count: {
          select: { assignedLeads: { where: { crmStage: { not: "CONVERTED_TO_CASE" } } } },
        },
      },
    });
    analysts.sort(
      (a, b) => a._count.assignedLeads - b._count.assignedLeads || a.id.localeCompare(b.id),
    );
    return analysts[0]?.id ?? null;
  }
}
