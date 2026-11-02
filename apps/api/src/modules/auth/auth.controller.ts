import { Body, Controller, Get, HttpCode, NotFoundException, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";

import { PrismaService } from "../../common/prisma.service.js";
import { AuditService } from "../../common/audit.service.js";
import { clientIp, CurrentUser, Public, type AuthedRequest } from "../../common/auth/decorators.js";
import { TokensService, type SessionClaims } from "../../common/auth/tokens.service.js";
import { OtpService } from "./otp.service.js";

const requestSchema = z.object({
  phone: z.string().min(10).max(20),
  purpose: z.literal("LOGIN").default("LOGIN"),
});

/** The Login Gateway: full name, mobile (verified by OTP) and email. */
const verifySchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
  name: z.string().trim().min(2, "Enter your full name.").max(120),
  email: z.email("Enter a valid email address.").max(200),
});

@Controller("auth")
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Whether sign-in codes can be delivered right now. Never returns a code. */
  @Public()
  @Get("otp/status")
  status() {
    return this.otp.status();
  }

  /** Sends a sign-in code to the mobile number. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("otp/request")
  @HttpCode(200)
  request(
    @Body({ schema: requestSchema }) body: z.infer<typeof requestSchema>,
    @Req() req: AuthedRequest,
  ) {
    return this.otp.request(body.phone, body.purpose, clientIp(req));
  }

  /**
   * Signs in through the Login Gateway. A first sign-in creates an investor
   * account with the name and email given; later sign-ins fill a missing email.
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("otp/verify")
  @HttpCode(200)
  async verify(
    @Body({ schema: verifySchema }) body: z.infer<typeof verifySchema>,
    @Req() req: AuthedRequest,
  ) {
    const { phone, issuedBy } = await this.otp.verifyChallenge(body.phone, "LOGIN", body.code);
    const db = this.prisma.client;
    const known = await db.user.findUnique({ where: { phone }, select: { email: true } });
    const user = await db.user.upsert({
      where: { phone },
      update: { lastLoginAt: new Date(), ...(known?.email ? {} : { email: body.email }) },
      create: {
        phone,
        name: body.name,
        email: body.email,
        role: "INVESTOR",
        lastLoginAt: new Date(),
      },
    });
    if (!user.isActive) throw new NotFoundException("This account is closed.");
    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: "auth.login",
      entityType: "user",
      entityId: user.id,
      ip: clientIp(req),
      ...(issuedBy ? { data: { via: "CALL_ISSUED_CODE", issuedBy } } : {}),
    });
    const session = this.tokens.signSession(user);
    return {
      ...session,
      user: { id: user.id, name: user.name, role: user.role, phone: user.phone, email: user.email },
    };
  }

  @Get("me")
  async me(@CurrentUser() claims: SessionClaims) {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: claims.sub },
      include: { associate: { select: { id: true, referralCode: true, isVerified: true } } },
    });
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      phone: user.phone,
      email: user.email,
      associate: user.associate,
    };
  }
}
