import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";

import { clientIp, Public, type AuthedRequest } from "../../common/auth/decorators.js";
import { contactSchema, IntakeService, PENDING_CALL_VERIFICATION } from "./intake.service.js";

const callbackSchema = z
  .object({
    contact: contactSchema,
    note: z.string().trim().max(500).optional(),
    consent: z.literal(true, { error: "We need your consent to call you." }),
  })
  .strict();

/** Intake that needs no sign-in code (see IntakeService). */
@Controller("intake")
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  /** Which flows are open without a sign-in code right now. */
  @Public()
  @Get("status")
  status() {
    const sms = this.intake.smsAvailable();
    return {
      smsSignIn: sms,
      guestDossier: true,
      guestTrace: !sms,
      callback: true,
    };
  }

  /** A visitor asks the team to call and verify their number. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("callback")
  @HttpCode(200)
  async callback(
    @Body({ schema: callbackSchema }) body: z.infer<typeof callbackSchema>,
    @Req() req: AuthedRequest,
  ) {
    await this.intake.lead(body.contact, "CALLBACK_REQUEST", clientIp(req), {
      context: body.note ? { note: body.note } : {},
    });
    return { status: "RECEIVED", contactVerification: PENDING_CALL_VERIFICATION };
  }
}
