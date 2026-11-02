/**
 * Operator command: a one-time sign-in code for an existing staff account,
 * printed in this terminal. While sign-in codes cannot be texted it is how
 * staff reach the CRM, where they verify clients' numbers by call.
 *
 * Whoever runs it already holds the database credentials, so it grants no
 * access they do not have. It refuses client accounts (those are verified by
 * call from the CRM), inactive accounts and the development administrator
 * number in production. The code lives 15 minutes, works once, is stored
 * only as an HMAC, and the issue is written to the audit log.
 *
 *   NODE_ENV=production node --env-file=<api env> dist/cli/issue-staff-code.js \
 *     --phone 98765xxxxx --confirm-production
 */
import { randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";

import { normalizeIndianMobile, STAFF_ROLES } from "@finsol/shared";
import pg from "pg";

import { loadEnv, type Env } from "../config/env.js";
import { DEV_DEFAULT_ADMIN_PHONE, otpCodeHash } from "../modules/auth/otp.service.js";

const TTL_MS = 15 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export class StaffCodeRefused extends Error {}

/** Issues the code; throws StaffCodeRefused with the reason when it must not. */
export async function issueStaffCode(opts: {
  env: Env;
  rawPhone: string;
  confirmProduction: boolean;
}): Promise<{ code: string; role: string; phone: string; expiresAt: Date }> {
  const { env } = opts;
  const refuse = (m: string): never => {
    throw new StaffCodeRefused(m);
  };
  const phone =
    normalizeIndianMobile(opts.rawPhone) ??
    refuse("pass --phone with a 10-digit Indian mobile number.");
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  const local = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
  if (!local && !opts.confirmProduction)
    refuse("this is not a local database; add --confirm-production to go ahead.");
  if (env.NODE_ENV === "production" && phone === DEV_DEFAULT_ADMIN_PHONE)
    refuse(
      "that is the development administrator number, which cannot sign in to production. " +
        "Give the administrator account a real mobile number first.",
    );

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string; role: string; is_active: boolean }>(
      `SELECT id, role::text AS role, is_active FROM users WHERE phone = $1`,
      [phone],
    );
    const user = rows[0] ?? refuse("no account has this number.");
    if (!(STAFF_ROLES as readonly string[]).includes(user.role))
      refuse("not a staff account. Clients are verified by call from the CRM board.");
    if (!user.is_active) refuse("this account is closed.");

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + TTL_MS);
    await db.query("BEGIN");
    try {
      // Any earlier unused code for this number stops working.
      await db.query(
        `UPDATE otp_challenges SET consumed_at = now()
          WHERE phone = $1 AND purpose = 'LOGIN' AND consumed_at IS NULL`,
        [phone],
      );
      await db.query(
        `INSERT INTO otp_challenges (id, phone, purpose, code_hash, expires_at, issued_by)
         VALUES (gen_random_uuid(), $1, 'LOGIN', $2, $3, $4)`,
        [phone, otpCodeHash(env.OTP_SECRET, phone, "LOGIN", code), expiresAt, user.id],
      );
      await db.query(
        `INSERT INTO audit_events (action, entity_type, entity_id, data)
         VALUES ('auth.operator_code.issue', 'user', $1, $2)`,
        [user.id, JSON.stringify({ expiresAt: expiresAt.toISOString() })],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
    return { code, role: user.role, phone, expiresAt };
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await issueStaffCode({
      env: loadEnv(process.env),
      rawPhone: arg("phone") ?? "",
      confirmProduction: process.argv.includes("--confirm-production"),
    });
    console.log(`Sign-in code for the ${r.role} account ending ${r.phone.slice(-4)}: ${r.code}`);
    console.log(
      `Use it once at /login (form "A Finsol analyst gave you a sign-in code") before ${r.expiresAt.toISOString()}.`,
    );
  } catch (e) {
    console.error(`issue-staff-code: ${(e as Error).message}`);
    process.exit(1);
  }
}
