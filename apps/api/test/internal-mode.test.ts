import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/config/env.js";
import { ConsoleOtpSender, DisabledOtpSender } from "../src/common/providers/otp.provider.js";
import { DatabaseEncryptedStorage } from "../src/common/providers/storage.provider.js";
import { OtpService } from "../src/modules/auth/otp.service.js";

const JWT = "a-production-session-secret-of-at-least-32-chars";

describe("production environment without SMS or eSign keys", () => {
  it("pauses OTP sign-in (no code shown anywhere) and derives the other secrets", () => {
    const env = loadEnv({ NODE_ENV: "production", JWT_SECRET: JWT });
    expect(env.OTP_PROVIDER).toBe("disabled");
    expect(env.ESIGN_PROVIDER).toBe("mock");
    expect(env.STORAGE_PROVIDER).toBe("db");
    expect(env.OTP_SECRET).not.toBe(JWT);
    expect(env.OTP_SECRET).not.toBe(env.ESIGN_WEBHOOK_SECRET);
    expect(Buffer.from(env.STORAGE_ENCRYPTION_KEY!, "base64")).toHaveLength(32);
  });

  it("switches to the real providers once their keys are set", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      JWT_SECRET: JWT,
      MSG91_AUTH_KEY: "k",
      MSG91_TEMPLATE_ID: "t",
      LEEGALITY_AUTH_TOKEN: "l",
    });
    expect(env.OTP_PROVIDER).toBe("msg91");
    expect(env.ESIGN_PROVIDER).toBe("leegality");
  });

  it("still refuses to start without JWT_SECRET", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/JWT_SECRET/);
  });

  it("treats the old OTP_PROVIDER=internal as disabled and refuses the console sender", () => {
    expect(
      loadEnv({ NODE_ENV: "production", JWT_SECRET: JWT, OTP_PROVIDER: "internal" }).OTP_PROVIDER,
    ).toBe("disabled");
    expect(() =>
      loadEnv({ NODE_ENV: "production", JWT_SECRET: JWT, OTP_PROVIDER: "console" }),
    ).toThrow(/development and tests only/);
  });
});

function otpService(sender: ConsoleOtpSender | DisabledOtpSender, nodeEnv = "test") {
  const created: unknown[] = [];
  const prisma = {
    client: {
      otpChallenge: {
        findMany: async () => [],
        create: async (a: unknown) => {
          created.push(a);
          return { id: "c1" };
        },
        update: async () => ({}),
        findFirst: async () => null,
      },
      user: { findUnique: async () => ({ role: "INVESTOR" }) },
    },
  };
  const env = { ...loadEnv({ NODE_ENV: "test" }), NODE_ENV: nodeEnv } as ReturnType<typeof loadEnv>;
  return { service: new OtpService(prisma as never, sender, env), created };
}

describe("OTP without an SMS provider", () => {
  it("refuses honestly, creates no challenge and returns no code", async () => {
    const { service, created } = otpService(new DisabledOtpSender());
    expect(service.status()).toMatchObject({ available: false });
    await expect(service.request("9876543210", "LOGIN", null)).rejects.toMatchObject({
      status: 503,
    });
    // Only a code an analyst read out on a call could match; there is none here.
    await expect(service.verify("9876543210", "LOGIN", "123456")).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.verify("9876543210", "UNLOCK", "123456")).rejects.toMatchObject({
      status: 503,
    });
    expect(created).toHaveLength(0);
  });
});

describe("OTP responses", () => {
  it("never include the code, in any environment", async () => {
    const { service } = otpService(new ConsoleOtpSender());
    const res = await service.request("9876543210", "LOGIN", null);
    expect(res).not.toHaveProperty("testCode");
    expect(JSON.stringify(res)).not.toMatch(/\b\d{6}\b/);
  });

  it("refuse the development administrator number in production", async () => {
    const { service } = otpService(new ConsoleOtpSender(), "production");
    await expect(service.request("9000000001", "LOGIN", null)).rejects.toMatchObject({
      status: 400,
    });
  });

  it("refuse to print codes from the console sender in production", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(new ConsoleOtpSender().send("+919876543210", "123456")).rejects.toThrow(
        /production/,
      );
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe("database vault", () => {
  it("stores ciphertext and reads back the original", async () => {
    const rows = new Map<string, Uint8Array>();
    const db = {
      storedObject: {
        upsert: async (a: { where: { key: string }; create: { data: Uint8Array } }) =>
          rows.set(a.where.key, a.create.data),
        findUnique: async (a: { where: { key: string } }) => {
          const data = rows.get(a.where.key);
          return data ? { data } : null;
        },
      },
    };
    const vault = new DatabaseEncryptedStorage(db as never, undefined);
    const body = Buffer.from("%PDF-1.7 Digital Mandate FE-0001");
    const url = await vault.put("cases/x/mandate.pdf", body, "application/pdf");
    expect(url).toBe("db://cases/x/mandate.pdf");
    expect(Buffer.from(rows.get("cases/x/mandate.pdf")!).includes(body)).toBe(false);
    expect((await vault.get(url)).equals(body)).toBe(true);
    await expect(vault.get("db://missing")).rejects.toThrow(/not found/);
  });
});

describe("client address vouched for by the website's server", () => {
  const secret = "a-shared-proxy-secret-of-at-least-32-chars";
  const req = (headers: Record<string, string>) => ({ headers }) as never;

  it("is used only with the shared secret and a valid address", async () => {
    const { vouchedClientIp } = await import("../src/common/auth/client-ip.js");
    const ok = { "x-finsol-proxy-key": secret, "x-finsol-client-ip": "203.0.113.7" };
    expect(vouchedClientIp(req(ok), secret)).toBe("203.0.113.7");
    expect(vouchedClientIp(req({ ...ok, "x-finsol-client-ip": "2001:db8::1" }), secret)).toBe(
      "2001:db8::1",
    );
    expect(vouchedClientIp(req({ ...ok, "x-finsol-proxy-key": "guess" }), secret)).toBeUndefined();
    expect(
      vouchedClientIp(req({ ...ok, "x-finsol-client-ip": "not-an-ip" }), secret),
    ).toBeUndefined();
    expect(vouchedClientIp(req({ "x-finsol-client-ip": "203.0.113.7" }), secret)).toBeUndefined();
    expect(vouchedClientIp(req(ok), undefined)).toBeUndefined();
  });
});
