import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { Prisma } from "@finsol/db";
import { RECOVERABLE_SHARES_SQL, RTA_LABELS, type CustodyStatus } from "@finsol/shared";
import { z } from "zod";

import { Public, Roles } from "../../common/auth/decorators.js";
import { PrismaService } from "../../common/prisma.service.js";
import { isoDate, isoTime, num, numOrNull } from "../../common/serialize.js";

const slugSchema = z.string().regex(/^[a-z0-9-]{2,120}$/);
const listSchema = z.object({ q: z.string().trim().max(80).optional() });

@Controller("companies")
export class CompaniesController {
  constructor(private readonly prisma: PrismaService) {}

  /** Every company, for the SEO index, sitemaps and the calculator picker. */
  @Public()
  @Get()
  async list(@Query({ schema: listSchema }) query: z.infer<typeof listSchema>) {
    const companies = await this.prisma.client.company.findMany({
      where: query.q ? { name: { contains: query.q, mode: "insensitive" } } : undefined,
      orderBy: { name: "asc" },
      include: { _count: { select: { folios: true } } },
    });
    return companies.map((c) => ({
      slug: c.slug,
      name: c.name,
      sector: c.sector,
      tickerNse: c.tickerNse,
      currentMarketPrice: numOrNull(c.currentMarketPrice),
      priceUpdatedAt: isoTime(c.priceUpdatedAt),
      folioCount: c._count.folios,
      updatedAt: isoTime(c.updatedAt),
    }));
  }

  /**
   * One company for the public page: price, bonus and split history and what
   * our records hold. Registrar, nodal officer and identifier details are
   * staff-only (GET /admin/companies/:slug).
   */
  @Public()
  @Get(":slug")
  async get(@Param("slug", { schema: slugSchema }) slug: string) {
    const { company: c, records } = await loadCompany(this.prisma, slug);
    return {
      slug: c.slug,
      name: c.name,
      sector: c.sector,
      tickerNse: c.tickerNse,
      tickerBse: c.tickerBse,
      currentMarketPrice: numOrNull(c.currentMarketPrice),
      priceUpdatedAt: isoTime(c.priceUpdatedAt),
      priceQuoteAt: isoTime(c.priceQuoteAt),
      priceAttemptedAt: isoTime(c.priceAttemptedAt),
      priceError: c.priceError ? "The latest refresh failed." : null,
      priceSource: c.priceSource,
      corporateActions: c.corporateActions.map((a) => ({
        actionType: a.actionType,
        exDate: isoDate(a.exDate)!,
        ratioFrom: numOrNull(a.ratioFrom),
        ratioTo: numOrNull(a.ratioTo),
        dividendPerShare: numOrNull(a.dividendPerShare),
        notes: a.notes,
        source: a.source,
      })),
      records,
    };
  }
}

async function loadCompany(prisma: PrismaService, slug: string) {
  const db = prisma.client;
  const company = await db.company.findUnique({
    where: { slug },
    include: { corporateActions: { orderBy: { exDate: "asc" } } },
  });
  if (!company) throw new NotFoundException("No company with that name in our records.");
  // Shares count only for share records (see countsShareValue); the shares
  // behind an unclaimed dividend still belong to the holder.
  const custody = await db.$queryRaw<
    { custody_status: string; folios: bigint; shares: bigint; dividend: string }[]
  >`
    SELECT f.custody_status::text AS custody_status, count(*) AS folios,
           coalesce(sum(f.post_action_shares) FILTER (WHERE ${Prisma.raw(RECOVERABLE_SHARES_SQL)}), 0)::bigint AS shares,
           coalesce(sum(f.unclaimed_dividend_amount), 0)::text AS dividend
      FROM unclaimed_folios f
     WHERE f.company_id = ${company.id}::uuid AND f.review_status = 'PUBLISHED'
     GROUP BY 1`;
  return {
    company,
    records: custody.map((g) => ({
      custodyStatus: g.custody_status as CustodyStatus,
      folios: Number(g.folios),
      shares: Number(g.shares),
      dividendRupees: Number(g.dividend),
    })),
  };
}

/** The internal company file: identifiers, registrar and nodal officer contacts. Staff only. */
@Roles("VALUATION_ANALYST", "LEGAL_OPS_EXEC")
@Controller("admin/companies")
export class AdminCompaniesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const companies = await this.prisma.client.company.findMany({ orderBy: { name: "asc" } });
    return companies.map((c) => ({
      slug: c.slug,
      name: c.name,
      cin: c.cin,
      isin: c.isin,
      rtaLabel: c.rtaDisplayName ?? RTA_LABELS[c.rtaName],
      nodalOfficerName: c.nodalOfficerName,
      nodalOfficerEmail: c.nodalOfficerEmail,
    }));
  }

  @Get(":slug")
  async get(@Param("slug", { schema: slugSchema }) slug: string) {
    const { company: c, records } = await loadCompany(this.prisma, slug);
    return {
      slug: c.slug,
      name: c.name,
      cin: c.cin,
      statutoryBasis: c.statutoryBasis,
      isin: c.isin,
      sector: c.sector,
      tickerNse: c.tickerNse,
      tickerBse: c.tickerBse,
      rta: {
        name: c.rtaName,
        label: c.rtaDisplayName ?? RTA_LABELS[c.rtaName],
        address: c.rtaAddress,
        email: c.rtaEmail,
        phone: c.rtaPhone,
        website: c.rtaWebsite,
      },
      nodalOfficer: {
        name: c.nodalOfficerName,
        emails: c.nodalOfficerEmail
          ? c.nodalOfficerEmail
              .split("/")
              .map((e) => e.trim())
              .filter(Boolean)
          : [],
        phone: c.nodalOfficerPhone,
        address: c.nodalOfficeAddress,
        deputies: (c.deputyNodalOfficers as { name: string; email: string | null }[] | null) ?? [],
      },
      contacts: { source: c.contactsSource, verifiedAt: isoTime(c.contactsVerifiedAt) },
      irPageUrl: c.irPageUrl,
      records,
    };
  }
}
