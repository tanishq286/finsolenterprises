import "reflect-metadata";

import { StandardSchemaValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";

import { AppModule } from "./app.module.js";
import { clientIpMiddleware } from "./common/auth/client-ip.js";
import { ENV, type Env } from "./config/env.js";

// BigInt (paise totals) serialises as a number in JSON responses.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};

/** Builds the HTTP app; shared by main.ts and the end-to-end tests. */
export async function createApp(
  opts: { logger?: false; abortOnError?: boolean } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: false,
    // Serverless passes false: throw instead of process.exit, so the handler can answer 503.
    abortOnError: opts.abortOnError ?? true,
    ...(opts.logger === false ? { logger: false } : {}),
  });
  const env = app.get<Env>(ENV);
  app.set("trust proxy", 1);
  app.use(clientIpMiddleware(env.FINSOL_PROXY_SECRET));
  app.use(helmet({ crossOriginResourcePolicy: { policy: "same-site" } }));
  app.enableCors({
    origin: env.WEB_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
    allowedHeaders: ["content-type", "authorization"],
  });
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();
  return app;
}
