import { createHmac } from "node:crypto";

import { z } from "zod";

/**
 * Environment, validated once at start-up. Every integration has a local
 * default (console OTP, simulated eSign, encrypted local storage, Postgres
 * search, inline jobs) so the API runs with nothing but a database; set the
 * provider variables to switch each one to its real service.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    DATABASE_URL: z.string().default("postgresql://postgres:postgres@127.0.0.1:54329/recoveryos"),
    WEB_ORIGIN: z.string().default("http://localhost:3000"),
    API_PUBLIC_URL: z.string().default("http://localhost:4000"),

    JWT_SECRET: z.string().min(32).optional(),
    OTP_SECRET: z.string().min(32).optional(),
    SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),

    /**
     * Unset: MSG91 or Twilio when their keys are present; otherwise "console" in
     * development and test, and "disabled" in production (sign-in by mobile code
     * is paused with an honest message; codes are never shown or logged).
     * "internal" is accepted from older deployments and means "disabled".
     */
    OTP_PROVIDER: z.enum(["console", "disabled", "internal", "msg91", "twilio"]).optional(),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_TEMPLATE_ID: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),

    /**
     * Unset: Digio or Leegality when their keys are present, otherwise "mock"
     * (an OTP-confirmed electronic acceptance inside the portal, labelled as such).
     */
    ESIGN_PROVIDER: z.enum(["mock", "digio", "leegality"]).optional(),
    ESIGN_WEBHOOK_SECRET: z.string().min(16).optional(),
    DIGIO_CLIENT_ID: z.string().optional(),
    DIGIO_CLIENT_SECRET: z.string().optional(),
    DIGIO_BASE_URL: z.string().default("https://ext.digio.in:444"),
    LEEGALITY_AUTH_TOKEN: z.string().optional(),
    LEEGALITY_BASE_URL: z.string().default("https://app1.leegality.com/api/v3.0"),

    /** Unset: "db" in production (no persistent disk on Vercel), otherwise "local". */
    STORAGE_PROVIDER: z.enum(["local", "s3", "db"]).optional(),
    STORAGE_LOCAL_DIR: z.string().default("../../.uploads"),
    STORAGE_ENCRYPTION_KEY: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("ap-south-1"),
    S3_KMS_KEY_ID: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),

    REDIS_URL: z.string().optional(),
    MEILI_HOST: z.string().optional(),
    MEILI_API_KEY: z.string().optional(),

    /** Valuation PDF reports a mobile number may download per day. */
    VALUATION_REPORTS_PER_DAY: z.coerce.number().int().min(0).default(2),
    /** Searches a signed-in member may run per day before an analyst takes over. */
    MEMBER_SEARCHES_PER_DAY: z.coerce.number().int().min(1).default(60),
    /** On-demand refresh of company-published statements when a search runs. Off under test. */
    LIVE_SYNC_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((v) =>
        // Off on Vercel: per-instance memory and start-up work don't suit serverless.
        v === undefined ? process.env.NODE_ENV !== "test" && !process.env.VERCEL : v === "true",
      ),
    /** Load the search indexes into cache on start-up. Off under test. */
    PREWARM_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((v) =>
        // Off on Vercel: per-instance memory and start-up work don't suit serverless.
        v === undefined ? process.env.NODE_ENV !== "test" && !process.env.VERCEL : v === "true",
      ),
    /** Hours before the same company's published statements are fetched again. */
    LIVE_SYNC_TTL_HOURS: z.coerce.number().min(1).default(24),
    /** Live NSE/BSE price sync. Off by default under test. */
    MARKET_SYNC_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? process.env.NODE_ENV !== "test" : v === "true")),
    MARKET_SYNC_INTERVAL_MINUTES: z.coerce.number().min(1).default(15),
    MAX_UPLOAD_MB: z.coerce.number().default(10),
    /** Bearer token Vercel Cron sends to /api/v1/cron/daily. */
    CRON_SECRET: z.string().min(16).optional(),
    /** Set by Vercel: no long-lived process, so no timers or start-up sync. */
    VERCEL: z.string().optional(),
    /**
     * Shared with the website's server. A request carrying it may say which
     * visitor it is acting for (x-finsol-client-ip), so per-visitor rate limits
     * see visitors rather than the website's own address. Unset: the
     * connecting address is used, as before.
     */
    FINSOL_PROXY_SECRET: z.string().min(32).optional(),
    /** Neon's direct (non-PgBouncer) URL, used by the search pool's session settings. */
    DATABASE_URL_UNPOOLED: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Every other secret can be derived from JWT_SECRET (see loadEnv), so a
    // production deployment needs this one secret plus the folio keys.
    if (env.NODE_ENV === "production" && !env.JWT_SECRET)
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "JWT_SECRET is required in production",
      });
    // The console sender prints usable codes to the log.
    if (env.NODE_ENV === "production" && env.OTP_PROVIDER === "console")
      ctx.addIssue({
        code: "custom",
        path: ["OTP_PROVIDER"],
        message: "The console OTP provider is for development and tests only",
      });
  });

export type Env = Omit<
  z.infer<typeof schema>,
  "OTP_PROVIDER" | "ESIGN_PROVIDER" | "STORAGE_PROVIDER"
> & {
  JWT_SECRET: string;
  OTP_SECRET: string;
  ESIGN_WEBHOOK_SECRET: string;
  STORAGE_ENCRYPTION_KEY: string | undefined;
  OTP_PROVIDER: "console" | "disabled" | "msg91" | "twilio";
  ESIGN_PROVIDER: "mock" | "digio" | "leegality";
  STORAGE_PROVIDER: "local" | "s3" | "db";
  SERVERLESS: boolean;
};

function derive(root: string, label: string): string {
  return createHmac("sha256", root).update(`finsol:${label}`).digest("hex");
}

const DEV_SECRET = (label: string) => `finsol-development-only-${label}-0123456789abcdef`;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${lines}`);
  }
  const env = parsed.data;
  const prod = env.NODE_ENV === "production";
  // In production a missing secret is derived from JWT_SECRET with a distinct label,
  // so one secret never doubles as another.
  const secret = (value: string | undefined, label: string) =>
    value ?? (prod ? derive(env.JWT_SECRET!, label) : DEV_SECRET(label));
  const configured = env.OTP_PROVIDER === "internal" ? "disabled" : (env.OTP_PROVIDER ?? undefined);
  const otpProvider =
    configured ??
    (env.MSG91_AUTH_KEY && env.MSG91_TEMPLATE_ID
      ? "msg91"
      : env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
        ? "twilio"
        : prod
          ? "disabled"
          : "console");
  const esignProvider =
    env.ESIGN_PROVIDER ??
    (env.DIGIO_CLIENT_ID && env.DIGIO_CLIENT_SECRET
      ? "digio"
      : env.LEEGALITY_AUTH_TOKEN
        ? "leegality"
        : "mock");
  return {
    ...env,
    OTP_PROVIDER: otpProvider,
    SERVERLESS: Boolean(env.VERCEL),
    STORAGE_PROVIDER: env.STORAGE_PROVIDER ?? (prod ? "db" : "local"),
    ESIGN_PROVIDER: esignProvider,
    JWT_SECRET: env.JWT_SECRET ?? DEV_SECRET("session"),
    OTP_SECRET: secret(env.OTP_SECRET, "otp"),
    ESIGN_WEBHOOK_SECRET: secret(env.ESIGN_WEBHOOK_SECRET, "esign"),
    STORAGE_ENCRYPTION_KEY:
      env.STORAGE_ENCRYPTION_KEY ??
      (prod
        ? createHmac("sha256", env.JWT_SECRET!).update("finsol:storage").digest("base64")
        : undefined),
  };
}

export const ENV = Symbol("ENV");
