import { IntakeController } from "./modules/intake/intake.controller.js";
import { IntakeService } from "./modules/intake/intake.service.js";
import { AdminTracesController, TracesController } from "./modules/traces/traces.controller.js";
import { TracesService } from "./modules/traces/traces.service.js";
import { Module } from "@nestjs/common";
import type pg from "pg";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";

import { ENV, loadEnv, type Env } from "./config/env.js";
import { PrewarmService } from "./common/prewarm.service.js";
import { AuditService } from "./common/audit.service.js";
import { AuthGuard } from "./common/auth/auth.guard.js";
import { TokensService } from "./common/auth/tokens.service.js";
import { PrismaService } from "./common/prisma.service.js";
import { createEsignProvider, ESIGN_PROVIDER } from "./common/providers/esign.provider.js";
import { createOtpSender, OTP_SENDER } from "./common/providers/otp.provider.js";
import { createStorage, DOCUMENT_STORAGE } from "./common/providers/storage.provider.js";
import { JobHandlersService } from "./common/queue/job-handlers.service.js";
import { JobQueueService } from "./common/queue/job-queue.service.js";
import { AssociatesController } from "./modules/associates/associates.controller.js";
import { AssociatesService } from "./modules/associates/associates.service.js";
import { AuthController } from "./modules/auth/auth.controller.js";
import { OtpService } from "./modules/auth/otp.service.js";
import { ClientIpThrottlerGuard } from "./common/auth/client-ip.js";
import { CasesController, WebhooksController } from "./modules/cases/cases.controller.js";
import { CasesService } from "./modules/cases/cases.service.js";
import {
  AdminCompaniesController,
  CompaniesController,
} from "./modules/companies/companies.controller.js";
import { CronController } from "./modules/cron/cron.controller.js";
import { CrmController } from "./modules/crm/crm.controller.js";
import { CrmService } from "./modules/crm/crm.service.js";
import { HealthController } from "./modules/health/health.controller.js";
import { ImportsController } from "./modules/imports/imports.controller.js";
import { ImportsService } from "./modules/imports/imports.service.js";
import { SearchController } from "./modules/search/search.controller.js";
import { MeiliSearchEngine, PostgresSearchEngine } from "./modules/search/search-engine.js";
import { SearchService } from "./modules/search/search.service.js";
import { LiveMcaSyncService } from "./modules/search/live-mca-sync.service.js";
import { SEARCH_ENGINE, SEARCH_POOL } from "./modules/search/search.tokens.js";
import { StatsController } from "./modules/stats/stats.controller.js";
import { MarketController } from "./market/market.controller.js";
import { defaultProviders, MarketService, QUOTE_PROVIDERS } from "./market/market.service.js";
import { EquitiesService } from "./market/equities.service.js";
import { ValuationController } from "./modules/valuation/valuation.controller.js";

/**
 * One module: the API is small enough that feature folders are clearer than
 * a dozen Nest modules re-exporting the same providers.
 */
@Module({
  imports: [
    JwtModule.register({}),
    ThrottlerModule.forRoot({
      throttlers: [{ name: "default", ttl: 60_000, limit: 300 }],
      // The e2e suite signs in many times from one address.
      skipIf: () => process.env.NODE_ENV === "test",
    }),
  ],
  controllers: [
    TracesController,
    AdminTracesController,
    HealthController,
    AuthController,
    SearchController,
    CompaniesController,
    AdminCompaniesController,
    StatsController,
    CasesController,
    WebhooksController,
    CrmController,
    AssociatesController,
    ImportsController,
    MarketController,
    ValuationController,
    CronController,
    IntakeController,
  ],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: OTP_SENDER, inject: [ENV], useFactory: (env: Env) => createOtpSender(env) },
    { provide: ESIGN_PROVIDER, inject: [ENV], useFactory: (env: Env) => createEsignProvider(env) },
    {
      provide: DOCUMENT_STORAGE,
      inject: [ENV, PrismaService],
      useFactory: (env: Env, prisma: PrismaService) => createStorage(env, prisma.client),
    },
    {
      provide: SEARCH_POOL,
      inject: [PrismaService, ENV],
      // Session settings need a direct connection: Neon's PgBouncer refuses startup options.
      useFactory: (prisma: PrismaService, env: Env) =>
        PostgresSearchEngine.pool(env.DATABASE_URL_UNPOOLED ?? prisma.databaseUrl, {
          max: env.SERVERLESS ? 3 : 10,
        }),
    },
    {
      provide: SEARCH_ENGINE,
      inject: [ENV, SEARCH_POOL],
      useFactory: (env: Env, pool: pg.Pool) => {
        const pg = new PostgresSearchEngine(pool);
        return env.MEILI_HOST ? new MeiliSearchEngine(env.MEILI_HOST, env.MEILI_API_KEY, pg) : pg;
      },
    },
    PrismaService,
    TracesService,
    AuditService,
    PrewarmService,
    TokensService,
    JobQueueService,
    JobHandlersService,
    OtpService,
    IntakeService,
    SearchService,
    LiveMcaSyncService,
    CasesService,
    CrmService,
    AssociatesService,
    ImportsService,
    MarketService,
    EquitiesService,
    { provide: QUOTE_PROVIDERS, useFactory: defaultProviders },
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
