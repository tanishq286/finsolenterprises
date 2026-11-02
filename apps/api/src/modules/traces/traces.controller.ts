import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ALL_INDIA, INDIAN_STATES } from "@finsol/shared";
import { z } from "zod";
import { CurrentUser, Roles } from "../../common/auth/decorators.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { TracesService } from "./traces.service.js";

export const traceSchema = z
  .object({
    requestId: z.uuid(),
    holderName: z.string().trim().min(2).max(120),
    scope: z.enum([...INDIAN_STATES, ALL_INDIA]),
    relationship: z.enum(["SELF", "FAMILY", "AUTHORISED_REPRESENTATIVE", "LEGAL_HEIR"]),
    oldCity: z.string().trim().max(100).optional(),
    oldAddress: z.string().trim().max(300).optional(),
    certificateStatus: z.enum(["AVAILABLE", "LOST", "PARTIAL", "UNKNOWN"]).optional(),
    companies: z.string().trim().max(500).optional(),
    years: z.string().trim().max(100).optional(),
    claimantName: z.string().trim().max(120).optional(),
    claimantEmail: z.string().trim().email().max(150).optional(),
    claimantMobile: z.string().trim().max(20).optional(),
    consent: z.literal(true),
  })
  .strict();
export type TraceInput = z.infer<typeof traceSchema>;
export const checkSchema = z
  .object({
    source: z.url().max(1000),
    authorisation: z.string().trim().min(10).max(500),
    outcome: z.enum(["MATCH_FOUND", "NO_MATCH", "NEEDS_MORE_DETAILS", "NOT_AVAILABLE"]),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type CheckInput = z.infer<typeof checkSchema>;
const statusSchema = z.object({
  status: z.enum([
    "OPEN",
    "PENDING_AUDIT",
    "NEEDS_DETAILS",
    "IN_PROGRESS",
    "RTA_ARCHIVE_SEARCHED",
    "MATCH_FOUND",
    "CLOSED_FOUND",
    "CLOSED_NOT_FOUND",
    "CLOSED",
  ]),
});
const id = z.uuid();

@Controller("traces")
export class TracesController {
  constructor(private readonly traces: TracesService) {}
  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(@Body({ schema: traceSchema }) body: TraceInput, @CurrentUser() user: SessionClaims) {
    return this.traces.create(body, user);
  }
  @Get()
  mine(@CurrentUser() user: SessionClaims) {
    return this.traces.mine(user);
  }
  @Post(":id/withdraw")
  withdraw(@Param("id", { schema: id }) traceId: string, @CurrentUser() user: SessionClaims) {
    return this.traces.withdraw(traceId, user);
  }
}

@Roles("VALUATION_ANALYST", "LEGAL_OPS_EXEC")
@Controller("admin/traces")
export class AdminTracesController {
  constructor(private readonly traces: TracesService) {}
  @Get()
  list(
    @Query({ schema: z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }) })
    q: {
      page: number;
    },
  ) {
    return this.traces.list(q.page);
  }
  @Get(":id")
  get(@Param("id", { schema: id }) traceId: string, @CurrentUser() user: SessionClaims) {
    return this.traces.get(traceId, user);
  }
  @Post(":id/checks")
  check(
    @Param("id", { schema: id }) traceId: string,
    @Body({ schema: checkSchema }) body: CheckInput,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.traces.check(traceId, body, user);
  }
  @Patch(":id")
  update(
    @Param("id", { schema: id }) traceId: string,
    @Body({ schema: statusSchema }) body: z.infer<typeof statusSchema>,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.traces.update(traceId, body.status, user);
  }
}
