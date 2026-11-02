import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { CRM_STAGES, SCENARIO_TYPES } from "@finsol/shared";
import { z } from "zod";

import { CurrentUser, Roles } from "../../common/auth/decorators.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { CasesService } from "../cases/cases.service.js";
import { CASE_COLUMNS, CrmService } from "./crm.service.js";

const id = z.uuid();
const updateSchema = z.object({
  crmStage: z.enum(CRM_STAGES).optional(),
  assignedAnalystId: z.uuid().nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
  clearReviewAlert: z.literal(true).optional(),
});
const convertSchema = z.object({
  folioId: z.uuid(),
  scenarioType: z.enum(SCENARIO_TYPES),
  /** Custom pricing: optional here, settable on the case until the mandate is issued. */
  agreedSuccessFeePct: z.number().gt(0).max(50).nullable().optional(),
  /** Outcome of the review when another client already has a case on this holding. */
  competingClaimReview: z.string().trim().min(10).max(1000).optional(),
});
const releaseSchema = z.object({
  folioIds: z.array(z.uuid()).min(1).max(10),
  /** Why this claimant is entitled to see these numbers (documents checked, relationship). */
  reason: z
    .string()
    .trim()
    .min(10, "Record why the claimant may see these folio numbers.")
    .max(1000),
  /** Required when another person also claims these holdings. */
  competingClaimReview: z.string().trim().min(10).max(1000).optional(),
});
const verifyCallSchema = z
  .object({
    /** What the call established, for the audit log. */
    note: z
      .string()
      .trim()
      .min(5, "Note what the call confirmed (who answered, details checked).")
      .max(500),
  })
  .strict();
const moveCaseSchema = z.object({
  caseCode: z.string(),
  column: z.enum(CASE_COLUMNS.map((c) => c.id) as [string, ...string[]]),
});

@Roles("VALUATION_ANALYST", "LEGAL_OPS_EXEC")
@Controller("crm")
export class CrmController {
  constructor(
    private readonly crm: CrmService,
    private readonly cases: CasesService,
  ) {}

  @Get("board")
  board(
    @Query({ schema: z.object({ mine: z.enum(["1", "0"]).optional() }) }) q: { mine?: "1" | "0" },
    @CurrentUser() user: SessionClaims,
  ) {
    return this.crm.board({ mine: q.mine === "1", user });
  }

  @Get("team")
  team() {
    return this.crm.team();
  }

  @Patch("leads/:id")
  update(
    @Param("id", { schema: id }) leadId: string,
    @Body({ schema: updateSchema }) body: z.infer<typeof updateSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.crm.update(leadId, user, body);
  }

  @Post("leads/:id/convert")
  convert(
    @Param("id", { schema: id }) leadId: string,
    @Body({ schema: convertSchema }) body: z.infer<typeof convertSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.crm.convert(leadId, user, body);
  }

  /** Shows the claimant the folio numbers of these holdings. */
  @Post("leads/:id/release-folios")
  releaseFolios(
    @Param("id", { schema: id }) leadId: string,
    @Body({ schema: releaseSchema }) body: z.infer<typeof releaseSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.crm.releaseFolios(
      leadId,
      user,
      body.folioIds,
      body.reason,
      body.competingClaimReview,
    );
  }

  /** Records that an analyst called the number back and confirmed it. */
  @Post("leads/:id/verify-call")
  @HttpCode(200)
  verifyCall(
    @Param("id", { schema: id }) leadId: string,
    @Body({ schema: verifyCallSchema }) body: z.infer<typeof verifyCallSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.crm.verifyCall(leadId, user, body.note);
  }

  /** A one-time sign-in code to read out on that call; shown once, never stored. */
  @Post("leads/:id/sign-in-code")
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  issueSignInCode(@Param("id", { schema: id }) leadId: string, @CurrentUser() user: SessionClaims) {
    return this.crm.issueSignInCode(leadId, user);
  }

  /** Dragging a case card to the next column advances it one R.E.C.O.V.E.R. step. */
  @Post("cases/move")
  async moveCase(
    @Body({ schema: moveCaseSchema }) body: z.infer<typeof moveCaseSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    const target = CASE_COLUMNS.find((c) => c.id === body.column)!;
    const current = await this.cases.get(body.caseCode, user);
    const toStep = Math.min(...target.steps.filter((s) => s > current.recoverStep));
    if (!Number.isFinite(toStep)) return current;
    return this.cases.advance(body.caseCode, user, toStep);
  }
}
