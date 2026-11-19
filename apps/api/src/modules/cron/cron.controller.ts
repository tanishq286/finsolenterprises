import { timingSafeEqual } from "node:crypto";

import { Controller, Get, Headers, Inject, NotFoundException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";

import { Public } from "../../common/auth/decorators.js";
import { ENV, type Env } from "../../config/env.js";
import { EquitiesService } from "../../market/equities.service.js";
import { MarketService } from "../../market/market.service.js";
import { SearchDemandService } from "../search/search-demand.service.js";

/**
 * Scheduled work for serverless hosts, which have no long-lived process for
 * timers: Vercel Cron calls this once a day with `Authorization: Bearer
 * CRON_SECRET`. Without CRON_SECRET the route does not exist.
 */
@Controller("cron")
export class CronController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly market: MarketService,
    private readonly equities: EquitiesService,
    private readonly demand: SearchDemandService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get("daily")
  async daily(@Headers("authorization") auth: string | undefined) {
    const expected = this.env.CRON_SECRET ? Buffer.from(`Bearer ${this.env.CRON_SECRET}`) : null;
    const given = Buffer.from(auth ?? "");
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new NotFoundException();
    const directory = await this.equities.refreshDirectory();
    const prices = await this.market.syncAll();
    const demandLog = await this.demand.prune();
    return { directory, prices, demandLog };
  }
}
