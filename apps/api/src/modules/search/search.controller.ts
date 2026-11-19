import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Sse,
  type MessageEvent,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { Throttle } from "@nestjs/throttler";
import {
  ALL_INDIA,
  CUSTODY_STATUSES,
  INDIAN_STATES,
  PHYSICAL_CERT_STATUSES,
  RELATIONSHIPS,
} from "@finsol/shared";
import { z } from "zod";

import {
  clientIp,
  CurrentUser,
  Public,
  Roles,
  type AuthedRequest,
} from "../../common/auth/decorators.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { LiveMcaSyncService } from "./live-mca-sync.service.js";
import { SearchDemandService } from "./search-demand.service.js";
import { SearchService } from "./search.service.js";

const name = z.string().trim().max(60).optional();

export const searchQuerySchema = z
  .object({
    /** The 3-Minute Check sends the investor's name as one field. */
    fullName: z.string().trim().max(120).optional(),
    jointHolderName: z.string().trim().max(120).optional(),
    firstName: name,
    middleName: name,
    lastName: name,
    state: z.enum([...INDIAN_STATES, ALL_INDIA], {
      error: "Choose the state on the investor's last known address, or All India.",
    }),
    custodyStatus: z.enum(CUSTODY_STATUSES).optional(),
  })
  .refine((q) => q.firstName || q.middleName || q.lastName || q.fullName, {
    message: "Enter the investor's name.",
  });

export const folioSearchSchema = z.object({
  company: z.string().trim().min(1, { error: "Enter the company name." }).max(120),
  folio: z
    .string()
    .trim()
    .min(1, { error: "Enter the folio number." })
    .max(40)
    .regex(/^[A-Za-z0-9 ./_-]+$/, {
      error: "Enter the folio number as printed on the certificate.",
    }),
  state: z.enum(INDIAN_STATES).optional(),
});

export const demandQuerySchema = z.object({
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(30), z.literal(90)]))
    .default(30),
});

export const claimSchema = z.object({
  folioIds: z.array(z.uuid()).min(1).max(10),
  relationshipToHolder: z.enum(RELATIONSHIPS),
  physicalCertStatus: z.enum(PHYSICAL_CERT_STATUSES),
  referralCode: z.string().trim().max(20).optional(),
  consent: z.literal(true, { error: "We need your consent to call you about these holdings." }),
});

@Controller("search")
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly live: LiveMcaSyncService,
    private readonly demand: SearchDemandService,
  ) {}

  /**
   * GET /api/v1/search/unclaimed: the 3-Minute Check (name + state, optional
   * joint holder). What a row reveals depends on who asks: see ResultAccess.
   */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("unclaimed")
  unclaimed(
    @Query({ schema: searchQuerySchema }) query: z.infer<typeof searchQuerySchema>,
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.search.search(query, { user, ip: clientIp(req) });
  }

  /**
   * GET /api/v1/search/folio: exact company + folio lookup. The public gets
   * only whether a record exists; members and staff get the tiered rows.
   * Tighter than the name search: folio numbers are short and guessable.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("folio")
  folio(
    @Query({ schema: folioSearchSchema }) query: z.infer<typeof folioSearchSchema>,
    @CurrentUser() user: SessionClaims | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.search.searchByFolio(query, { user, ip: clientIp(req) });
  }

  /** GET /api/v1/search/demand?days=30|90: staff only. Zero-result searches, aggregated. */
  @Roles("VALUATION_ANALYST", "LEGAL_OPS_EXEC")
  @Get("demand")
  demandReport(@Query({ schema: demandQuerySchema }) query: z.infer<typeof demandQuerySchema>) {
    return this.demand.report(query.days);
  }

  /** GET /api/v1/search/live/:id: server-sent events for the live refresh a search started. */
  @Public()
  @Sse("live/:id")
  liveEvents(@Param("id", { schema: z.uuid() }) id: string): Observable<MessageEvent> {
    const events = this.live.events(id);
    if (!events) throw new NotFoundException("That refresh has finished or expired. Search again.");
    return events.pipe(map((data) => ({ data }) as MessageEvent));
  }

  /** POST /api/v1/search/claim: a signed-in member asks Finsol to take up the chosen holdings. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("claim")
  @HttpCode(200)
  claim(
    @Body({ schema: claimSchema }) body: z.infer<typeof claimSchema>,
    @CurrentUser() user: SessionClaims,
    @Req() req: AuthedRequest,
  ) {
    return this.search.claim(body, user, clientIp(req));
  }
}
