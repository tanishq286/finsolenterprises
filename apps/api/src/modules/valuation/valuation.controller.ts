import { randomBytes, randomUUID } from "node:crypto";

import type { Role } from "@finsol/shared";
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  claimEstimate,
  describeQuote,
  maskPhone,
  MIN_PURCHASE_YEAR,
  portfolioTotals,
  valueEquityHolding,
  type HoldingValuation,
} from "@finsol/shared";
import type { Response } from "express";
import { z } from "zod";

import { ENV, type Env } from "../../config/env.js";
import { AuditService } from "../../common/audit.service.js";
import { clientIp, CurrentUser, Public, type AuthedRequest } from "../../common/auth/decorators.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { EquitiesService } from "../../market/equities.service.js";
import {
  contactSchema,
  IntakeService,
  PENDING_CALL_VERIFICATION,
} from "../intake/intake.service.js";
import { buildValuationPdf, type ValuationReportInput } from "./valuation-pdf.js";

const reportSchema = z.object({
  holdings: z
    .array(
      z.object({
        symbol: z.string().regex(/^[A-Za-z0-9&._-]{1,20}$/),
        exchange: z.enum(["NSE", "BSE"]),
        purchaseYear: z.number().int().min(MIN_PURCHASE_YEAR).max(new Date().getUTCFullYear()),
        originalShares: z.number().int().min(1).max(10_000_000),
        /** Only when the visitor overrode the synced price. */
        manualPrice: z.number().positive().max(10_000_000).nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});

const guestReportSchema = reportSchema.extend({
  contact: contactSchema,
  consent: z.literal(true, { error: "We need your consent to call you about this report." }),
});

/**
 * POST /api/v1/valuation/report: the calculator's Valuation Dossier (PDF).
 * Signed in, or as a guest who leaves a name, mobile and email; at most
 * VALUATION_REPORTS_PER_DAY per mobile number. Every figure is recomputed
 * here from the same price and event history the calculator shows.
 */
@Controller("valuation")
export class ValuationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly equities: EquitiesService,
    private readonly audit: AuditService,
    private readonly intake: IntakeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Signed-in: the Login Gateway verified the mobile by OTP. */
  @Post("report")
  @HttpCode(200)
  async report(
    @Body({ schema: reportSchema }) body: z.infer<typeof reportSchema>,
    @CurrentUser() claims: SessionClaims,
    @Res() res: Response,
  ) {
    const user = await this.prisma.client.user.findUniqueOrThrow({ where: { id: claims.sub } });
    await this.issue(body, res, {
      userId: user.id,
      leadId: null,
      phone: user.phone,
      preparedFor: { name: user.name, phoneMasked: maskPhone(user.phone), email: user.email },
      contactVerification: "LOGIN_OTP",
      actor: { id: user.id, role: user.role },
      ip: null,
    });
  }

  /**
   * No sign-in code needed: the visitor gives a name, mobile and email, which
   * become a lead marked PENDING_CALL_VERIFICATION. The report holds only the
   * figures the visitor asked for, so nothing private is exposed by an
   * unverified number. Same per-mobile daily limit as signed-in reports.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("report/guest")
  @HttpCode(200)
  async guestReport(
    @Body({ schema: guestReportSchema }) body: z.infer<typeof guestReportSchema>,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const phone = this.intake.phone(body.contact.phone);
    await this.assertUnderDailyLimit(phone);
    const lead = await this.intake.lead(body.contact, "VALUATION_DOSSIER", clientIp(req), {
      context: { holdings: body.holdings.length },
    });
    await this.issue(body, res, {
      userId: null,
      leadId: lead.id,
      phone: lead.phone,
      preparedFor: {
        name: lead.name,
        phoneMasked: maskPhone(lead.phone),
        email: lead.email,
        unverified: true,
      },
      contactVerification: PENDING_CALL_VERIFICATION,
      actor: null,
      ip: clientIp(req),
    });
  }

  private async assertUnderDailyLimit(phone: string): Promise<number> {
    const today = await this.prisma.client.valuationReport.count({
      where: { phone, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    });
    if (today >= this.env.VALUATION_REPORTS_PER_DAY)
      throw new HttpException(
        `Each mobile number can download ${this.env.VALUATION_REPORTS_PER_DAY} reports a day. Try again tomorrow, or ask your analyst.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    return today;
  }

  /** Recomputes every figure, records the report and sends the PDF. */
  private async issue(
    body: z.infer<typeof reportSchema>,
    res: Response,
    owner: {
      userId: string | null;
      leadId: string | null;
      phone: string;
      preparedFor: ValuationReportInput["preparedFor"];
      contactVerification: "LOGIN_OTP" | typeof PENDING_CALL_VERIFICATION;
      actor: { id: string; role: Role } | null;
      ip: string | null;
    },
  ) {
    const db = this.prisma.client;
    const today = await this.assertUnderDailyLimit(owner.phone);
    const rows: HoldingValuation[] = [];
    const notes: string[] = [];
    const quoteTimes: Date[] = [];
    for (const h of body.holdings) {
      const d = await this.equities.detail(h.symbol, h.exchange);
      const manual = h.manualPrice ?? null;
      rows.push(
        valueEquityHolding(
          {
            symbol: d.symbol,
            exchange: d.exchange,
            name: d.name,
            purchaseYear: h.purchaseYear,
            originalShares: h.originalShares,
            pricePerShare: manual ?? d.price,
            priceIsManual: manual !== null,
          },
          d,
        ),
      );
      if (!manual && d.priceQuoteAt) quoteTimes.push(new Date(d.priceQuoteAt));
      // The same description the calculator shows for this price.
      const q = describeQuote({
        price: manual ?? d.price,
        quoteAt: d.priceQuoteAt,
        retrievedAt: d.priceRetrievedAt,
        attemptedAt: d.priceAttemptedAt,
        error: d.priceError,
        manual: manual !== null,
        source: d.priceSource,
      });
      notes.push(
        `${q.label}: ${q.detail} ${d.actionsBasis === "verified" ? "Bonus/split history checked against company filings." : d.actionsKnown ? "Bonus/split history from the exchange record." : ""}`.trim(),
      );
    }
    const totals = portfolioTotals(rows);
    const issuedAt = new Date();
    const reportCode = `FE-VAL-${issuedAt.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
    await db.valuationReport.create({
      data: {
        id: randomUUID(),
        reportCode,
        userId: owner.userId,
        leadId: owner.leadId,
        contactVerification: owner.contactVerification,
        phone: owner.phone,
        holdings: rows as never,
        totalValuePaise: BigInt(totals.totalPaise),
      },
    });
    await this.audit.record({
      actorId: owner.actor?.id ?? null,
      actorRole: owner.actor?.role ?? null,
      ip: owner.ip,
      action: "valuation.report",
      entityType: "valuation_report",
      entityId: reportCode,
      data: { holdings: rows.length, totalPaise: totals.totalPaise },
    });
    const pdf = await buildValuationPdf({
      reportCode,
      issuedAt,
      preparedFor: owner.preparedFor,
      rows,
      totals,
      estimate: claimEstimate(totals),
      priceNotes: notes,
      pricesAsOf: quoteTimes.length
        ? new Date(Math.max(...quoteTimes.map((t) => t.getTime())))
        : null,
    });
    res
      .status(200)
      .setHeader("content-type", "application/pdf")
      .setHeader("content-disposition", `attachment; filename="${reportCode}.pdf"`)
      .setHeader("x-report-code", reportCode)
      .setHeader("x-reports-left-today", String(this.env.VALUATION_REPORTS_PER_DAY - today - 1))
      .send(pdf);
  }
}
