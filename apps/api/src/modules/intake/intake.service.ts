import { BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { normalizeIndianMobile, type PhysicalCertStatus, type Relationship } from "@finsol/shared";
import { z } from "zod";

import { AuditService } from "../../common/audit.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import { OtpService } from "../auth/otp.service.js";

/** Contact details a visitor types in. Kept as given: nobody has verified them. */
export const contactSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name.").max(120),
    phone: z.string().trim().min(10, "Enter a 10-digit Indian mobile number.").max(20),
    email: z.email("Enter a valid email address.").max(200),
  })
  .strict();
export type ContactInput = z.infer<typeof contactSchema>;

export type IntakeSource = "VALUATION_DOSSIER" | "DEEPER_TRACE" | "CALLBACK_REQUEST";

/** How a mobile number given without a sign-in code is marked until an analyst calls it. */
export const PENDING_CALL_VERIFICATION = "PENDING_CALL_VERIFICATION";

/** Intake requests a single mobile number or email may make in a day. */
export const INTAKE_PER_DAY = 6;

const DAY_MS = 86_400_000;

/**
 * Intake without a sign-in code: a Valuation Dossier, a Deeper Trace request or
 * a request for a verification call. Each becomes a lead for the team with
 * phone_otp_verified = false and PENDING_CALL_VERIFICATION; it never creates or
 * signs in to an account, so nobody can reach another person's records by
 * typing their number.
 */
@Injectable()
export class IntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly audit: AuditService,
  ) {}

  /** Whether sign-in codes can be texted right now. */
  smsAvailable(): boolean {
    return this.otp.status().available;
  }

  /** +91XXXXXXXXXX, or a 400 the form can show. */
  phone(raw: string): string {
    const phone = normalizeIndianMobile(raw);
    if (!phone) throw new BadRequestException("Enter a 10-digit Indian mobile number.");
    return phone;
  }

  /**
   * Records the visitor as an unverified lead (reusing their open lead from the
   * last day for the same source) and returns it. Throws 429 past
   * INTAKE_PER_DAY requests a day for the same mobile or email.
   */
  async lead(
    contact: ContactInput,
    source: IntakeSource,
    ip: string | null,
    extra: {
      relationship?: Relationship | null;
      certificates?: PhysicalCertStatus | null;
      context?: Record<string, unknown>;
    } = {},
  ): Promise<{ id: string; phone: string; email: string; name: string }> {
    const db = this.prisma.client;
    const phone = this.phone(contact.phone);
    const email = contact.email.trim().toLowerCase();
    const since = new Date(Date.now() - DAY_MS);
    const recent = await db.leadInquiry.count({
      where: {
        intakeSource: { not: null },
        createdAt: { gte: since },
        OR: [{ phone }, { email }],
      },
    });
    if (recent >= INTAKE_PER_DAY)
      throw new HttpException(
        "We already have several requests from these details today. Our team will call you; for anything urgent, email claims@finsolenterprises.com.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    const context = {
      source,
      contactVerification: PENDING_CALL_VERIFICATION,
      receivedAt: new Date().toISOString(),
      ...extra.context,
    };
    const open = await db.leadInquiry.findFirst({
      where: {
        phone,
        email,
        phoneOtpVerified: false,
        intakeSource: source,
        crmStage: "NEW_SEARCH_LEAD",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const lead = open
      ? await db.leadInquiry.update({
          where: { id: open.id },
          data: { claimantName: contact.name, searchContext: context as never },
          select: { id: true },
        })
      : await db.leadInquiry.create({
          data: {
            claimantName: contact.name,
            phone,
            phoneOtpVerified: false,
            email,
            relationshipToHolder: extra.relationship ?? null,
            physicalCertStatus: extra.certificates ?? null,
            intakeSource: source,
            searchContext: context as never,
          },
          select: { id: true },
        });
    await this.audit.record({
      action: `intake.${source.toLowerCase()}`,
      entityType: "lead",
      entityId: lead.id,
      data: { contactVerification: PENDING_CALL_VERIFICATION },
      ip,
    });
    return { id: lead.id, phone, email, name: contact.name };
  }
}
