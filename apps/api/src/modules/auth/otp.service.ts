import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import {
  BadGatewayException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { BRAND_EMAILS, normalizeIndianMobile } from "@finsol/shared";

import { ENV, type Env } from "../../config/env.js";
import { PrismaService } from "../../common/prisma.service.js";
import { OTP_SENDER, type OtpSender } from "../../common/providers/otp.provider.js";

/** LOGIN signs in; UNLOCK confirms the Digital Mandate when no eSign provider is configured. */
export type OtpPurpose = "LOGIN" | "UNLOCK";

const TTL_MS = 5 * 60_000;
/** A code read out on a verification call lives long enough to be typed after the call. */
const ISSUED_TTL_MS = 15 * 60_000;
const MAX_ISSUED_PER_HOUR = 3;
const RESEND_AFTER_MS = 30_000;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

/** How a code is stored: an HMAC, never the code. Shared with the operator CLI. */
export function otpCodeHash(secret: string, phone: string, purpose: OtpPurpose, code: string) {
  return createHmac("sha256", secret).update(`${phone}:${purpose}:${code}`).digest("hex");
}

/** The development seed's administrator number. It must never sign in to production. */
export const DEV_DEFAULT_ADMIN_PHONE = "+919000000001";

export const OTP_PAUSED_MESSAGE = `Sign-in by mobile code is paused while our SMS provider is being connected. Search, company pages and the calculator still work. For help with a claim, email ${BRAND_EMAILS.support}.`;

/**
 * One-time codes typed into this site by the person who asked for them.
 * Codes are 6 digits, live 5 minutes, allow 5 tries, and are stored only as
 * an HMAC. Sending is rate-limited per phone (one every 30 s, five an hour).
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private readonly log = new Logger("OTP");

  /** Whether codes can be delivered at all, for the sign-in screen. Never reveals a code. */
  status() {
    return {
      available: this.sender.available,
      channel: this.sender.available ? "sms" : null,
      message: this.sender.available ? null : OTP_PAUSED_MESSAGE,
      /** A code an analyst read out on a verification call is accepted either way. */
      callIssuedCodes: true,
    };
  }

  private assertNotDevAdmin(phone: string) {
    if (this.env.NODE_ENV === "production" && phone === DEV_DEFAULT_ADMIN_PHONE)
      throw new BadRequestException("This number cannot be used to sign in.");
  }

  private assertAllowed(phone: string) {
    if (!this.sender.available) throw new ServiceUnavailableException(OTP_PAUSED_MESSAGE);
    this.assertNotDevAdmin(phone);
  }

  /**
   * A sign-in code for an analyst to read out on a verification call, for a
   * number they have just confirmed by calling it. Only client accounts can
   * be opened this way: never a staff number, so no one can sign in as a
   * colleague. Returned once to the analyst, stored only as an HMAC.
   */
  async issueForCall(rawPhone: string, issuedBy: string) {
    const phone = this.phoneOrThrow(rawPhone);
    this.assertNotDevAdmin(phone);
    const db = this.prisma.client;
    const account = await db.user.findUnique({ where: { phone }, select: { role: true } });
    if (account && account.role !== "INVESTOR" && account.role !== "ASSOCIATE_PARTNER")
      throw new ConflictException(
        "Staff accounts cannot be opened with a code read out on a call.",
      );
    const issued = await db.otpChallenge.count({
      where: {
        phone,
        purpose: "LOGIN",
        issuedBy: { not: null },
        createdAt: { gte: new Date(Date.now() - 3_600_000) },
      },
    });
    if (issued >= MAX_ISSUED_PER_HOUR)
      throw new HttpException(
        "Three codes have been issued for this number in the last hour. Try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // Any earlier unused code for this number stops working.
    await db.otpChallenge.updateMany({
      where: { phone, purpose: "LOGIN", consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + ISSUED_TTL_MS);
    await db.otpChallenge.create({
      data: {
        phone,
        purpose: "LOGIN",
        codeHash: this.hash(phone, "LOGIN", code),
        expiresAt,
        issuedBy,
      },
    });
    return { phone, code, expiresAt: expiresAt.toISOString() };
  }

  phoneOrThrow(raw: string): string {
    const phone = normalizeIndianMobile(raw);
    if (!phone) throw new BadRequestException("Enter a 10-digit Indian mobile number.");
    return phone;
  }

  private hash(phone: string, purpose: OtpPurpose, code: string): string {
    return otpCodeHash(this.env.OTP_SECRET, phone, purpose, code);
  }

  async request(rawPhone: string, purpose: OtpPurpose, ip: string | null) {
    const phone = this.phoneOrThrow(rawPhone);
    this.assertAllowed(phone);
    const db = this.prisma.client;
    const recent = await db.otpChallenge.findMany({
      where: { phone, purpose, createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const latest = recent[0];
    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_AFTER_MS) {
      const wait = Math.ceil((RESEND_AFTER_MS - (Date.now() - latest.createdAt.getTime())) / 1000);
      throw new HttpException(
        `Please wait ${wait} seconds before asking for another code.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (recent.length >= MAX_PER_HOUR) {
      throw new HttpException(
        "Too many codes for this number. Try again in an hour.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + TTL_MS);
    const challenge = await db.otpChallenge.create({
      data: { phone, purpose, codeHash: this.hash(phone, purpose, code), expiresAt, requestIp: ip },
    });
    try {
      await this.sender.send(phone, code);
    } catch (err) {
      // An undelivered code must not stay usable; the failure is logged without it.
      await db.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      this.log.error(`OTP delivery failed via ${this.sender.name}: ${(err as Error).message}`);
      throw new BadGatewayException(
        "We could not send the code just now. Please try again in a few minutes.",
      );
    }
    // The code is never part of the response, in any environment.
    return {
      phone,
      expiresAt: expiresAt.toISOString(),
      resendAfterSeconds: RESEND_AFTER_MS / 1000,
      channel: "sms" as const,
    };
  }

  /** Consumes the code. Throws one generic error for every failure, so nothing leaks. */
  async verify(rawPhone: string, purpose: OtpPurpose, code: string): Promise<string> {
    return (await this.verifyChallenge(rawPhone, purpose, code)).phone;
  }

  /** As verify, and says who issued the code when an analyst read it out on a call. */
  async verifyChallenge(
    rawPhone: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<{ phone: string; issuedBy: string | null }> {
    const phone = this.phoneOrThrow(rawPhone);
    this.assertNotDevAdmin(phone);
    // Without SMS the only codes in circulation are ones an analyst read out on
    // a verification call; nothing else is accepted, and UNLOCK never is.
    const issuedOnly = !this.sender.available;
    if (issuedOnly && purpose !== "LOGIN")
      throw new ServiceUnavailableException(OTP_PAUSED_MESSAGE);
    const invalid = new BadRequestException(
      issuedOnly
        ? "That code is wrong or has expired. Ask your Finsol analyst for a new one."
        : "That code is wrong or has expired. Ask for a new one.",
    );
    if (!/^\d{6}$/.test(code)) throw invalid;
    const db = this.prisma.client;
    const challenge = await db.otpChallenge.findFirst({
      where: {
        phone,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        ...(issuedOnly ? { issuedBy: { not: null } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (!challenge || challenge.attempts >= MAX_ATTEMPTS) throw invalid;
    if (challenge.issuedBy) {
      // Re-checked at use: a code read out on a call never opens a staff
      // account. The one exception is the operator command, which issues a
      // staff member's code in their own name (issued_by = the account).
      const account = await db.user.findUnique({
        where: { phone },
        select: { id: true, role: true },
      });
      const staff = account && account.role !== "INVESTOR" && account.role !== "ASSOCIATE_PARTNER";
      if (staff && challenge.issuedBy !== account.id) throw invalid;
    }
    await db.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    const expected = Buffer.from(challenge.codeHash, "hex");
    const given = Buffer.from(this.hash(phone, purpose, code), "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid;
    // Conditional update: two concurrent verifications cannot both consume it.
    const consumed = await db.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
    return { phone, issuedBy: challenge.issuedBy };
  }
}
