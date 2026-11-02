import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/common/prisma.service.js";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { ConsoleOtpSender, OTP_SENDER } from "../src/common/providers/otp.provider.js";
import { JobQueueService } from "../src/common/queue/job-queue.service.js";

let app: INestApplication;
let http: Parameters<typeof request>[0];
let otp: ConsoleOtpSender;

const PHONES = {
  admin: "+919000000001",
  analyst: "+919000000002",
  legal: "+919000000004",
  sunita: "+919000000011",
  venkatesh: "+919000000012",
  anil: "+919000000013",
  meera: "+919000000021",
};

async function login(phone: string, name?: string): Promise<string> {
  await request(http)
    .post("/api/v1/auth/otp/request")
    .send({ phone, purpose: "LOGIN" })
    .expect(200);
  const code = otp.lastCode(phone)!;
  const res = await request(http)
    .post("/api/v1/auth/otp/verify")
    .send({ phone, code, name: name ?? "Test User", email: "test.user@example.in" })
    .expect(200);
  return res.body.token as string;
}

const tokens: Record<string, string> = {};
const auth = (who: keyof typeof PHONES) => ({ authorization: `Bearer ${tokens[who]}` });

beforeAll(async () => {
  app = await createApp({ logger: false });
  await app.init();
  http = app.getHttpServer();
  otp = app.get(OTP_SENDER);
  for (const who of [
    "admin",
    "analyst",
    "legal",
    "sunita",
    "venkatesh",
    "anil",
    "meera",
  ] as const) {
    tokens[who] = await login(PHONES[who]);
  }
});

afterAll(async () => {
  await app?.close();
});

describe("health", () => {
  it("reports the local adapters", async () => {
    const res = await request(http).get("/api/v1/health").expect(200);
    expect(res.body.adapters).toMatchObject({
      otp: "console",
      esign: "mock",
      storage: "local",
      search: "postgres",
      jobs: "inline",
    });
  });
});

describe("GET /search/unclaimed: the 3-Minute Check", () => {
  it("finds spelling variants within the state and masks company, shares and value for the public", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "DELHI" })
      .expect(200);
    expect(res.body).toMatchObject({ mode: "LAST", access: "public", liveRefreshId: null });
    const names = res.body.results.map((r: { investorFullName: string }) => r.investorFullName);
    expect(names).toEqual(
      expect.arrayContaining(["Ramesh Kumar Agarwal", "Ramesh K Agrawal", "Kamla Devi Aggarwal"]),
    );
    const ril = res.body.results.find(
      (r: { investorFullName: string }) => r.investorFullName === "Ramesh Kumar Agarwal",
    );
    expect(ril).toMatchObject({
      access: "public",
      companyName: "R******e Industries Limited",
      companySlug: null,
      folioNumber: "RIL***21",
      folioReleased: false,
      postActionShares: null,
      estimatedTotalValuePaise: null,
      sharePricePaise: null,
      fatherOrSpouseName: "Om Prakash Agarwal",
      city: "New Delhi",
    });
    expect(JSON.stringify(res.body)).not.toContain("RIL0012345621");
    expect(JSON.stringify(res.body)).not.toContain("Reliance");
  });

  it("takes the investor's name as one field, with an optional joint holder", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({
        fullName: "Ramesh Kumar Agarwal",
        jointHolderName: "Kamla Devi Aggarwal",
        state: "DELHI",
      })
      .expect(200);
    expect(res.body.mode).toBe("FULL");
    expect(res.body.results[0]).toMatchObject({
      investorFullName: "Ramesh Kumar Agarwal",
      matchedHolder: "primary",
    });
    expect(
      res.body.results.find(
        (r: { investorFullName: string }) => r.investorFullName === "Kamla Devi Aggarwal",
      ),
    ).toMatchObject({ matchedHolder: "joint" });
    const joint = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Venkatesh Rao", jointHolderName: "Ramesh Kumar Agarwal", state: "DELHI" })
      .expect(200);
    expect(
      joint.body.results.find(
        (r: { investorFullName: string }) => r.investorFullName === "Ramesh Kumar Agarwal",
      ),
    ).toMatchObject({ matchedHolder: "joint" });
    const phonetic = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Debasish Chaudhary", state: "WEST_BENGAL" })
      .expect(200);
    expect(
      phonetic.body.results.map((r: { investorFullName: string }) => r.investorFullName),
    ).toContain("Debashish Chowdhury");
  });

  it("scopes to the state and filters custody", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "KERALA" })
      .expect(200);
    expect(
      res.body.results.map((r: { investorFullName: string }) => r.investorFullName),
    ).not.toContain("Ramesh Kumar Agarwal");
    const custody = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Aggarwal", state: "DELHI", custodyStatus: "COMPANY_SUSPENSE" })
      .expect(200);
    expect(
      custody.body.results.every(
        (r: { custodyStatus: string }) => r.custodyStatus === "COMPANY_SUSPENSE",
      ),
    ).toBe(true);
  });

  it("requires a state and a name", async () => {
    await request(http).get("/api/v1/search/unclaimed").query({ lastName: "Agarwal" }).expect(400);
    await request(http).get("/api/v1/search/unclaimed").query({ state: "DELHI" }).expect(400);
  });

  it("shows signed-in members company, shares and value, but never the folio number", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Ramesh Kumar Agarwal", state: "DELHI" })
      .set(auth("venkatesh"))
      .expect(200);
    expect(res.body.access).toBe("member");
    const ril = res.body.results[0];
    expect(ril).toMatchObject({
      access: "member",
      companyName: "Reliance Industries Limited",
      companySlug: "reliance-industries-limited",
      folioNumber: "RIL***21",
      folioReleased: false,
      postActionShares: 1600,
    });
    expect(ril.estimatedTotalValuePaise).toBeGreaterThan(1600 * 1000 * 100);
    expect(JSON.stringify(res.body)).not.toContain("RIL0012345621");
  });

  it("shows staff everything unmasked", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "DELHI" })
      .set(auth("analyst"))
      .expect(200);
    const ril = res.body.results.find(
      (r: { investorFullName: string }) => r.investorFullName === "Ramesh Kumar Agarwal",
    );
    expect(ril).toMatchObject({
      access: "staff",
      companyName: "Reliance Industries Limited",
      folioNumber: "RIL0012345621",
      folioReleased: true,
    });
  });
});

describe("Login Gateway, claims and analyst folio release", () => {
  const phone = "9876500001";
  let token: string;
  let folioId: string;

  beforeAll(async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "DELHI" });
    folioId = res.body.results.find(
      (r: { investorFullName: string }) => r.investorFullName === "Ramesh Kumar Agarwal",
    ).id;
  });

  it("asks for full name, mobile OTP and email", async () => {
    await request(http)
      .post("/api/v1/auth/otp/request")
      .send({ phone, purpose: "LOGIN" })
      .expect(200);
    const code = otp.lastCode("+919876500001")!;
    const wrong = code === "000000" ? "111111" : "000000";
    await request(http)
      .post("/api/v1/auth/otp/verify")
      .send({ phone, code, name: "Asha Agarwal" })
      .expect(400); // no email
    await request(http)
      .post("/api/v1/auth/otp/verify")
      .send({ phone, code: wrong, name: "Asha Agarwal", email: "asha@example.in" })
      .expect(400);
    const ok = await request(http)
      .post("/api/v1/auth/otp/verify")
      .send({ phone, code, name: "Asha Agarwal", email: "asha@example.in" })
      .expect(200);
    expect(ok.body.user).toMatchObject({ name: "Asha Agarwal", email: "asha@example.in" });
    token = ok.body.token;
  });

  it("needs a session to claim", async () => {
    await request(http)
      .post("/api/v1/search/claim")
      .send({
        folioIds: [folioId],
        relationshipToHolder: "SON_DAUGHTER",
        physicalCertStatus: "LOST",
        consent: true,
      })
      .expect(401);
  });

  it("records the claim as a lead, then shows the folio only once the analyst releases it", async () => {
    const asha = { authorization: `Bearer ${token}` };
    await request(http)
      .post("/api/v1/search/claim")
      .set(asha)
      .send({
        folioIds: [folioId],
        relationshipToHolder: "SON_DAUGHTER",
        physicalCertStatus: "LOST",
        consent: false,
      })
      .expect(400);
    const res = await request(http)
      .post("/api/v1/search/claim")
      .set(asha)
      .send({
        folioIds: [folioId],
        relationshipToHolder: "SON_DAUGHTER",
        physicalCertStatus: "LOST",
        referralCode: "rahul-del",
        consent: true,
      })
      .expect(200);
    expect(res.body.folioCount).toBe(1);

    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const lead = await db.query(
      "SELECT l.*, a.referral_code FROM leads_and_inquiries l LEFT JOIN associates a ON a.id = l.associate_id WHERE l.id = $1",
      [res.body.leadId],
    );
    await db.end();
    expect(lead.rows[0]).toMatchObject({
      phone: "+919876500001",
      claimant_name: "Asha Agarwal",
      email: "asha@example.in",
      phone_otp_verified: true,
      crm_stage: "NEW_SEARCH_LEAD",
      referral_code: "RAHUL-DEL",
    });
    expect(lead.rows[0].assigned_analyst_id).toBeTruthy();

    const before = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Ramesh Kumar Agarwal", state: "DELHI" })
      .set(asha)
      .expect(200);
    expect(before.body.results[0]).toMatchObject({ folioNumber: "RIL***21", folioReleased: false });

    await request(http)
      .post(`/api/v1/crm/leads/${res.body.leadId}/release-folios`)
      .set(asha)
      .send({ folioIds: [folioId] })
      .expect(403);
    // A release is a reviewed decision: without a recorded reason it is refused.
    await request(http)
      .post(`/api/v1/crm/leads/${res.body.leadId}/release-folios`)
      .set(auth("analyst"))
      .send({ folioIds: [folioId] })
      .expect(400);
    // Another client already has a case on this holding, so Asha's request is in review
    // and nothing is released until the reviewer records the outcome.
    expect(res.body.underReview).toBe(true);
    await request(http)
      .post(`/api/v1/crm/leads/${res.body.leadId}/release-folios`)
      .set(auth("analyst"))
      .send({ folioIds: [folioId], reason: "PAN and relationship documents checked by phone." })
      .expect(409);
    await request(http)
      .patch(`/api/v1/crm/leads/${res.body.leadId}`)
      .set(auth("analyst"))
      .send({ clearReviewAlert: true })
      .expect(200);
    await request(http)
      .post(`/api/v1/crm/leads/${res.body.leadId}/release-folios`)
      .set(auth("analyst"))
      .send({
        folioIds: [folioId],
        reason: "PAN and relationship documents checked by phone.",
        competingClaimReview: "Asha and the existing client are co-heirs; both verified.",
      })
      .expect(201);
    const after = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Ramesh Kumar Agarwal", state: "DELHI" })
      .set(asha)
      .expect(200);
    expect(after.body.results[0]).toMatchObject({
      folioNumber: "RIL0012345621",
      folioReleased: true,
    });
  });
});

describe("calculator: equities and valuation reports", () => {
  it("finds equities and returns verified bonus and split history", async () => {
    const list = await request(http)
      .get("/api/v1/market/equities")
      .query({ q: "torrent" })
      .expect(200);
    expect(list.body.results[0]).toMatchObject({ symbol: "TORNTPHARM", exchange: "NSE" });
    const torrent = await request(http).get("/api/v1/market/equities/NSE/TORNTPHARM").expect(200);
    expect(torrent.body).toMatchObject({ actionsBasis: "verified" });
    expect(torrent.body.actions).toHaveLength(4);
    const ril = await request(http).get("/api/v1/market/equities/NSE/RELIANCE").expect(200);
    expect(ril.body.price).toBeGreaterThan(0);
    expect(ril.body.priceSource).toBe("Test fixture");
  });

  it("issues an FE-VAL report PDF, at most twice a day per mobile", async () => {
    const holdings = [
      { symbol: "RELIANCE", exchange: "NSE", purchaseYear: 1999, originalShares: 100 },
      { symbol: "ITC", exchange: "NSE", purchaseYear: 2000, originalShares: 100, manualPrice: 400 },
    ];
    await request(http).post("/api/v1/valuation/report").send({ holdings }).expect(401);
    for (let i = 0; i < 2; i++) {
      const res = await request(http)
        .post("/api/v1/valuation/report")
        .set(auth("anil"))
        .send({ holdings })
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["x-report-code"]).toMatch(/^FE-VAL-\d{8}-[0-9A-F]{6}$/);
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
      if (i === 0) {
        // Commercial rules: custom pricing (no fee percentage, no net-of-fee
        // figure) and no DIY claim-form names on client material.
        const text = await pdfText(res.body as Buffer);
        expect(text).toContain("Total Claimable Wealth");
        expect(text).toContain(
          "Success-Based Fee: Custom (Zero Upfront — Quoted per Engagement Letter)",
        );
        expect(text).toContain(
          "Statutory Authority Claim & RTA Verification Filing (Prepared & Executed by Finsol)",
        );
        expect(text).not.toMatch(/IEPF-5|ISR-1|Success fee \(|GST on the fee|net in-hand/i);
        expect(text).not.toMatch(/\d+(\.\d+)?% (of value|success)/i);
      }
    }
    await request(http)
      .post("/api/v1/valuation/report")
      .set(auth("anil"))
      .send({ holdings })
      .expect(429);
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const rows = await db.query(
      "SELECT holdings FROM valuation_reports WHERE phone = '+919000000013' ORDER BY created_at",
    );
    await db.end();
    expect(rows.rows).toHaveLength(2);
    const [ril, itc] = rows.rows[0].holdings;
    expect(ril).toMatchObject({ currentShares: 800, events: 3, priceIsManual: false });
    expect(itc).toMatchObject({
      currentShares: 4500,
      priceIsManual: true,
      marketValuePaise: 4500 * 40000,
    });
  });
});

describe("auth and roles", () => {
  it("needs a session for private routes", async () => {
    await request(http).get("/api/v1/cases").expect(401);
    await request(http).get("/api/v1/cases").set({ authorization: "Bearer nonsense" }).expect(401);
  });

  it("keeps investors out of the CRM and the importer", async () => {
    await request(http).get("/api/v1/crm/board").set(auth("sunita")).expect(403);
    await request(http).get("/api/v1/admin/ingestion").set(auth("sunita")).expect(403);
    await request(http).get("/api/v1/crm/board").set(auth("analyst")).expect(200);
  });

  it("returns the signed-in user", async () => {
    const res = await request(http).get("/api/v1/auth/me").set(auth("meera")).expect(200);
    expect(res.body).toMatchObject({
      role: "ASSOCIATE_PARTNER",
      associate: { referralCode: "MEERA-PUN" },
    });
  });
});

describe("cases: R.E.C.O.V.E.R. tracker, eSign and vault", () => {
  it("shows clients only their own cases", async () => {
    const mine = await request(http).get("/api/v1/cases").set(auth("sunita")).expect(200);
    expect(mine.body.map((c: { caseCode: string }) => c.caseCode).sort()).toEqual([
      "RC-2026-1001",
      "RC-2026-1004",
    ]);
    await request(http).get("/api/v1/cases/RC-2026-1001").set(auth("venkatesh")).expect(404);
    const c = await request(http).get("/api/v1/cases/RC-2026-1001").set(auth("sunita")).expect(200);
    expect(c.body).toMatchObject({
      recoverStep: 3,
      viewerRole: "client",
      // Masked until the analyst releases it.
      holding: { folioNumber: "RIL***21", folioReleased: false },
      company: { name: "Reliance Industries Limited", internal: null },
      tracking: { claimFiled: false, holdingConfirmation: "REQUESTED" },
      internal: null,
      money: { feePct: null, realization: null },
      serviceStep: 2,
      steps: [],
    });
    expect(c.body.serviceSteps.map((s: { state: string }) => s.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    const text = JSON.stringify(c.body);
    for (const hidden of ["IEPF-5", "ISR-1", "nodal", "Nodal", "KFin", "RIL0012345621"])
      expect(text).not.toContain(hidden);
    const staffView = await request(http)
      .get("/api/v1/cases/RC-2026-1001")
      .set(auth("analyst"))
      .expect(200);
    expect(staffView.body.steps).toHaveLength(7);
    expect(staffView.body.company.internal.rtaLabel).toBe("KFin Technologies Limited");
    const credited = await request(http)
      .get("/api/v1/cases/RC-2026-1004")
      .set(auth("sunita"))
      .expect(200);
    expect(credited.body.holding.folioReleased).toBe(true);
    expect(c.body.vault.map((v: { docType: string }) => v.docType)).toContain("DEATH_CERTIFICATE");
  });

  it("does not let clients move their own case", async () => {
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("sunita"))
      .send({ toStep: 4 })
      .expect(403);
  });

  it("walks a case from Check to Realize, gated on eSign and the SRN", async () => {
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("analyst"))
      .send({ toStep: 5 })
      .expect(409); // no skipping
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("analyst"))
      .send({ toStep: 4 })
      .expect(200);
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/esign/start")
      .set(auth("sunita"))
      .expect(409); // not yet step 5
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("analyst"))
      .send({ toStep: 5 })
      .expect(200);
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("analyst"))
      .send({ toStep: 6 })
      .expect(409); // unsigned
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/esign/start")
      .set(auth("sunita"))
      .expect(409); // no custom quote yet
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/fee")
      .set(auth("sunita"))
      .send({ feePct: 1 })
      .expect(403);
    const quoted = await request(http)
      .patch("/api/v1/cases/RC-2026-1001/fee")
      .set(auth("analyst"))
      .send({ feePct: 10 })
      .expect(200);
    expect(quoted.body.money.feePct).toBe(10);

    const start = await request(http)
      .post("/api/v1/cases/RC-2026-1001/esign/start")
      .set(auth("sunita"))
      .expect(200);
    expect(start.body).toMatchObject({ provider: "mock", mode: "simulated", signUrl: null });
    const preview = await request(http)
      .get("/api/v1/cases/RC-2026-1001/mandate")
      .set(auth("sunita"))
      .expect(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");
    expect(preview.body.subarray(0, 5).toString()).toBe("%PDF-");

    const signed = await request(http)
      .post("/api/v1/cases/RC-2026-1001/esign/mock-complete")
      .set(auth("sunita"))
      .send({ aadhaarLast4: "1234", otp: "456789" })
      .expect(200);
    expect(signed.body.esign.status).toBe("SIGNED");
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/fee")
      .set(auth("analyst"))
      .send({ feePct: 12 })
      .expect(409); // fixed once the mandate is issued
    // Signing the mandate does not release the folio: release is a separate, reviewed step.
    expect(signed.body.events.map((e: { message: string }) => e.message).join(" ")).toMatch(
      /development simulator.*not a signature/,
    );
    expect(signed.body.esign.method).toBe("development-simulator");
    const clientView = await request(http)
      .get("/api/v1/cases/RC-2026-1001")
      .set(auth("sunita"))
      .expect(200);
    expect(clientView.body.holding).toMatchObject({
      folioNumber: "RIL***21",
      folioReleased: false,
    });
    // No reason: refused. Reason but no verified PAN: refused.
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/release-folio")
      .set(auth("analyst"))
      .send({})
      .expect(400);
    // Without a verified PAN the release is refused.
    const pan = clientView.body.vault.find((v: { docType: string }) => v.docType === "PAN");
    if (pan?.status !== "VERIFIED") {
      await request(http)
        .post("/api/v1/cases/RC-2026-1001/release-folio")
        .set(auth("analyst"))
        .send({
          reason: "Client identity and relationship confirmed.",
          competingClaimReview: "Co-heirs; both verified.",
        })
        .expect(409);
      await request(http)
        .post("/api/v1/cases/RC-2026-1001/documents/PAN")
        .set(auth("sunita"))
        .attach("file", Buffer.from("%PDF-1.4\n% test PAN\n"), {
          filename: "pan.pdf",
          contentType: "application/pdf",
        })
        .expect(201);
      await request(http)
        .patch("/api/v1/cases/RC-2026-1001/documents/PAN")
        .set(auth("legal"))
        .send({ status: "VERIFIED" })
        .expect(200);
    }
    // Asha's earlier request put this case's own lead into review too; a reviewer clears it.
    const caseLead = await (async () => {
      const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      const r = await db.query(
        "SELECT l.id, l.review_alert FROM leads_and_inquiries l JOIN recovery_cases c ON c.id = l.converted_case_id WHERE c.case_code = 'RC-2026-1001'",
      );
      await db.end();
      return r.rows[0] as { id: string; review_alert: string | null } | undefined;
    })();
    if (caseLead?.review_alert)
      await request(http)
        .patch(`/api/v1/crm/leads/${caseLead.id}`)
        .set(auth("analyst"))
        .send({ clearReviewAlert: true })
        .expect(200);
    // Asha's request is still open on the same holding: the review outcome is required.
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/release-folio")
      .set(auth("analyst"))
      .send({ reason: "Client identity and relationship confirmed." })
      .expect(409);
    const released = await request(http)
      .post("/api/v1/cases/RC-2026-1001/release-folio")
      .set(auth("analyst"))
      .send({
        reason: "Client identity and relationship confirmed.",
        competingClaimReview: "Co-heirs; both verified.",
      })
      .expect(200);
    expect(released.body.folioReleasedAt).toBeTruthy();
    expect(released.body.holding).toMatchObject({
      folioNumber: "RIL0012345621",
      folioReleased: true,
    });

    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("legal"))
      .send({ toStep: 6 })
      .expect(200);
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("legal"))
      .send({ toStep: 7 })
      .expect(409); // no SRN
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/tracking")
      .set(auth("legal"))
      .send({ mcaIepf5Srn: "12345" })
      .expect(400);
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/tracking")
      .set(auth("legal"))
      .send({ mcaIepf5Srn: "t11223344", nodalVerificationStatus: "IN_PROGRESS" })
      .expect(200);
    const done = await request(http)
      .post("/api/v1/cases/RC-2026-1001/advance")
      .set(auth("legal"))
      .send({ toStep: 7 })
      .expect(200);
    expect(done.body).toMatchObject({
      recoverStep: 7,
      tracking: { claimFiled: true, companyVerification: "IN_PROGRESS" },
      internal: { mcaIepf5Srn: "T11223344", nodalVerificationStatus: "IN_PROGRESS" },
    });
  });

  it("accrues the referring associate's commission once the credit is recorded", async () => {
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/tracking")
      .set(auth("legal"))
      .send({ creditedValueRupees: 2_000_000 })
      .expect(400); // credit not done
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/tracking")
      .set(auth("legal"))
      .send({ dematCreditStatus: "DONE", creditedValueRupees: 2_000_000 })
      .expect(200);
    await request(http)
      .patch("/api/v1/cases/RC-2026-1001/tracking")
      .set(auth("legal"))
      .send({ dematCreditStatus: "DONE", creditedValueRupees: 2_000_000 })
      .expect(200);
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const rows = await db.query(
      "SELECT amount_paise FROM commission_ledger l JOIN recovery_cases c ON c.id = l.case_id WHERE c.case_code = 'RC-2026-1001' AND entry_type = 'ACCRUAL'",
    );
    await db.end();
    expect(rows.rows).toHaveLength(1);
    // 30% of a 10% fee on ₹20,00,000 = ₹60,000
    expect(Number(rows.rows[0].amount_paise)).toBe(60_000_00);
  });

  it("stores uploads encrypted and serves them back intact", async () => {
    const pdf = Buffer.from("%PDF-1.4\n% test cancelled cheque\n");
    await request(http)
      .post("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE")
      .set(auth("anil"))
      .attach("file", Buffer.from("MZ"), {
        filename: "x.exe",
        contentType: "application/x-msdownload",
      })
      .expect(400);
    const up = await request(http)
      .post("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE")
      .set(auth("anil"))
      .attach("file", pdf, { filename: "cheque.pdf", contentType: "application/pdf" })
      .expect(201);
    const doc = up.body.vault.find((v: { docType: string }) => v.docType === "CANCELLED_CHEQUE");
    expect(doc).toMatchObject({ status: "UPLOADED", fileName: "cheque.pdf", hasFile: true });
    const back = await request(http)
      .get("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE/file")
      .set(auth("anil"))
      .expect(200);
    expect(Buffer.compare(back.body, pdf)).toBe(0);
    await request(http)
      .get("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE/file")
      .set(auth("sunita"))
      .expect(404);

    await request(http)
      .patch("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE")
      .set(auth("legal"))
      .send({ status: "REJECTED" })
      .expect(400);
    const reviewed = await request(http)
      .patch("/api/v1/cases/RC-2026-1003/documents/CANCELLED_CHEQUE")
      .set(auth("legal"))
      .send({ status: "VERIFIED" })
      .expect(200);
    expect(
      reviewed.body.vault.find((v: { docType: string }) => v.docType === "CANCELLED_CHEQUE").status,
    ).toBe("VERIFIED");
  });

  it("refuses an eSign webhook with a bad signature", async () => {
    await request(http)
      .post("/api/v1/webhooks/esign/mock")
      .set("x-finsol-signature", "00".repeat(32))
      .send({ requestId: "MOCK-x", status: "SIGNED" })
      .expect(401);
  });
});

describe("CRM board", () => {
  it("lays out lead and case columns and converts a lead into a case", async () => {
    const board = await request(http).get("/api/v1/crm/board").set(auth("analyst")).expect(200);
    const ids = board.body.columns.map((c: { id: string }) => c.id);
    expect(ids).toEqual([
      "NEW_SEARCH_LEAD",
      "RING_UP_DONE",
      "EVALUATION_IN_PROGRESS",
      "FEASIBILITY_CHECKED",
      "OFFER_SENT",
      "CASE_VERIFY",
      "CASE_EMPLOY",
      "CASE_REALIZE",
    ]);
    const offer = board.body.columns.find((c: { id: string }) => c.id === "OFFER_SENT").items[0];
    await request(http)
      .patch(`/api/v1/crm/leads/${offer.id}`)
      .set(auth("analyst"))
      .send({ crmStage: "CONVERTED_TO_CASE" })
      .expect(400);
    const created = await request(http)
      .post(`/api/v1/crm/leads/${offer.id}/convert`)
      .set(auth("analyst"))
      .send({
        folioId: offer.holdings[0].folioId,
        scenarioType: "STANDARD_IEPF5",
      })
      .expect(201);
    expect(created.body.agreedSuccessFeePct).toBeNull();
    expect(created.body.caseCode).toMatch(/^RC-\d{4}-\d{4}$/);
    expect(created.body.recoverStep).toBe(5);
    await request(http)
      .post(`/api/v1/crm/leads/${offer.id}/convert`)
      .set(auth("analyst"))
      .send({ folioId: offer.holdings[0].folioId, scenarioType: "STANDARD_IEPF5" })
      .expect(409);

    const lead = board.body.columns.find((c: { id: string }) => c.id === "RING_UP_DONE").items[0];
    const moved = await request(http)
      .patch(`/api/v1/crm/leads/${lead.id}`)
      .set(auth("analyst"))
      .send({ crmStage: "EVALUATION_IN_PROGRESS", notes: "Called, holder confirmed." })
      .expect(200);
    expect(moved.body.crmStage).toBe("EVALUATION_IN_PROGRESS");
  });
});

describe("associates", () => {
  it("lists only verified partners on the public locator", async () => {
    const all = await request(http).get("/api/v1/associates/locator").expect(200);
    expect(all.body.map((a: { referralCode: string }) => a.referralCode)).not.toContain(
      "DEBAS-KOL",
    );
    const kerala = await request(http)
      .get("/api/v1/associates/locator")
      .query({ state: "KERALA" })
      .expect(200);
    expect(kerala.body).toHaveLength(1);
    expect(JSON.stringify(all.body)).not.toContain("+9190000000");
  });

  it("registers a partner, who can then submit leads and see a ledger", async () => {
    const token = await login("+919811100001", "Neha Kapoor");
    const reg = await request(http)
      .post("/api/v1/associates/register")
      .set({ authorization: `Bearer ${token}` })
      .send({
        firmName: "Kapoor & Co, Company Secretaries",
        profession: "CS",
        state: "PUNJAB",
        city: "Ludhiana",
      })
      .expect(201);
    expect(reg.body.associate.isVerified).toBe(false);
    const partner = { authorization: `Bearer ${reg.body.session.token}` };
    await request(http)
      .post("/api/v1/associates/me/leads")
      .set(partner)
      .send({
        claimantName: "Gurpreet Singh",
        phone: "9876512345",
        relationshipToHolder: "SELF",
        physicalCertStatus: "AVAILABLE",
        holderName: "Gurpreet Singh",
        state: "PUNJAB",
        consentConfirmed: true,
      })
      .expect(201);
    const me = await request(http).get("/api/v1/associates/me").set(partner).expect(200);
    expect(me.body.leads).toHaveLength(1);
    expect(me.body.profile.revenueSharePct).toBe(30);
  });

  it("shows a partner's ledger with running balance", async () => {
    const me = await request(http).get("/api/v1/associates/me").set(auth("meera")).expect(200);
    expect(me.body.totals.accruedPaise).toBeGreaterThan(0);
    expect(me.body.totals.balancePaise).toBe(
      me.body.totals.accruedPaise - me.body.totals.paidPaise,
    );
  });
});

describe("IEPF-2 / IEPF-4 ingestion", () => {
  it("rejects unclassified share uploads instead of assuming completed transfer", async () => {
    await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("companySlug", "reliance-industries-limited")
      .attach(
        "file",
        Buffer.from("Investor First Name,Folio Number,Number of Shares\nTest,TEST123,100"),
        { filename: "shares.csv", contentType: "text/csv" },
      )
      .expect(400);
  });
  it("imports an IEPF-4 statement in the background and makes it searchable", async () => {
    const csv = [
      "Statement of shares transferred to IEPF,,,,,,,,,,,,,,,,",
      "Investor First Name,Investor Middle Name,Investor Last Name,Father/Husband First Name,Father/Husband Middle Name,Father/Husband Last Name,Address,Country,State,District,Pin Code,Folio Number,DP Id-Client Id-Account Number,Investment Type,Amount transferred,Number of underlying Shares,Proposed Date of transfer to IEPF",
      "Hemlata,,Bhargava,Suresh,,Bhargava,12 Civil Lines,India,Rajasthan,Jaipur,302006,RIL0099887766,,Shares,0,150,23-Oct-2019",
      "Hemlata,,Bhargava,Suresh,,Bhargava,12 Civil Lines,India,Rajasthan,Jaipur,302006,RIL0099887766,,Shares,0,150,23-Oct-2019",
      "Prakash,,Nambiar,Raman,,Nambiar,Kochi,India,Kerela,Ernakulam,,RIL0012121212,,Shares,0,40,2019-10-23",
      ",,,,,,,,,,,,,,,,",
      "Imran,,Qureshi,Abdul,,Qureshi,Dubai Marina,UAE,,,,RIL0055554444,,Shares,0,20,23/10/2019",
    ].join("\n");
    const up = await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("formType", "IEPF_4")
      .field("companySlug", "reliance-industries-limited")
      .attach("file", Buffer.from(csv), { filename: "iepf4-ril.csv", contentType: "text/csv" })
      .expect(201);
    await app.get(JobQueueService).drain();
    const job = await request(http)
      .get(`/api/v1/admin/ingestion/${up.body.id}`)
      .set(auth("admin"))
      .expect(200);
    expect(job.body).toMatchObject({
      status: "COMPLETED",
      totalRows: 4,
      insertedRows: 2,
      skippedRows: 1,
    });
    expect(job.body.errors[0].message).toContain("Kerela");

    const found = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Bhargav", state: "RAJASTHAN" })
      .set(auth("analyst"))
      .expect(200);
    expect(found.body.results[0]).toMatchObject({
      investorFullName: "Hemlata Bhargava",
      // 150 shares moved in Oct 2019, doubled by Reliance's Oct 2024 bonus inside the IEPF.
      postActionShares: 300,
      custodyStatus: "IEPF_AUTHORITY",
      transferFinancialYear: "2019-20",
      eventDate: "2019-10-23",
    });
    const abroad = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Qureshi", state: "OUT_OF_INDIA" })
      .expect(200);
    expect(abroad.body.total).toBe(1);
  });

  it("reads a real-layout .xlsx IEPF-2 statement with a title block and share rows", async () => {
    const XLSX = await import("xlsx");
    const header = [
      "Investor First Name",
      "Investor Middle Name",
      "Investor Last Name",
      "Father/Husband First Name",
      "Father/Husband Middle Name",
      "Father/Husband Last Name",
      "Address",
      "Country",
      "State",
      "District",
      "Pin Code",
      "Folio Number",
      "DP Id-Client Id-Account Number",
      "Investment Type",
      "Amount Transferred",
      "Proposed Date of Transfer to IEPF",
      "PAN",
      "Financial Year",
    ];
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Add Investor Details"],
      [
        "(i) Fill in the details below. First Name -> Mandatory if 'Last Name' is blank. DP Id-Client Id-Account Number -> 16 characters.",
      ],
      [],
      header,
      [
        "Gurmeet",
        "",
        "Kaur",
        "Harbans",
        "",
        "Singh",
        "12 Model Town",
        "INDIA",
        "",
        "Ludhiana",
        "141002",
        "TCS0045671234",
        "",
        "Amount for unpaid and unclaimed dividend",
        412.5,
        new Date(Date.UTC(2031, 6, 27)),
        "",
        "FY-1",
      ],
      [
        "Gurmeet",
        "",
        "Kaur",
        "Harbans",
        "",
        "Singh",
        "12 Model Town",
        "INDIA",
        "",
        "Ludhiana",
        "141002",
        "TCS0045671234",
        "",
        "Number of underlying Shares",
        75,
        new Date(Date.UTC(2031, 6, 27)),
        "",
        "FY-1",
      ],
      ["Total", "", "", "", "", "", "", "", "", "", "", "", "", "", 487.5, "", "", ""],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Investor Details");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const up = await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("companySlug", "tata-consultancy-services-limited")
      .field("sourceUrl", "https://example.org/investors/iepf-2.xlsx")
      .attach("file", buffer, {
        filename: "iepf-2.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      .expect(201);
    expect(up.body).toMatchObject({
      formType: "IEPF_2",
      sourceUrl: "https://example.org/investors/iepf-2.xlsx",
    });
    await app.get(JobQueueService).drain();
    const job = await request(http)
      .get(`/api/v1/admin/ingestion/${up.body.id}`)
      .set(auth("admin"))
      .expect(200);
    expect(job.body).toMatchObject({
      status: "COMPLETED",
      totalRows: 2,
      insertedRows: 1,
      skippedRows: 0,
    });
    // State came from the PIN code; the shares row became shares, not rupees.
    const found = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Gurmeet Kaur", state: "PUNJAB" })
      .set(auth("analyst"))
      .expect(200);
    expect(found.body.results[0]).toMatchObject({
      investorFullName: "Gurmeet Kaur",
      postActionShares: 75,
      custodyStatus: "COMPANY_SUSPENSE",
      unclaimedDividendPaise: 41250,
    });

    // The same statement again: updated in place, never double counted.
    const again = await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("companySlug", "tata-consultancy-services-limited")
      .attach("file", buffer, {
        filename: "iepf-2.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
      .expect(201);
    await app.get(JobQueueService).drain();
    const job2 = await request(http)
      .get(`/api/v1/admin/ingestion/${again.body.id}`)
      .set(auth("admin"))
      .expect(200);
    expect(job2.body).toMatchObject({ status: "COMPLETED", insertedRows: 0, updatedRows: 1 });
    const same = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Gurmeet Kaur", state: "PUNJAB" })
      .set(auth("analyst"))
      .expect(200);
    expect(same.body.results[0].unclaimedDividendPaise).toBe(41250);
  });

  it("reads a PDF statement table and keeps holders with no state searchable everywhere", async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([842, 595]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const cols = [40, 140, 240, 340, 440, 560, 680];
    const draw = (row: string[], y: number) =>
      row.forEach((t, i) => t && page.drawText(t, { x: cols[i]!, y, size: 8, font }));
    page.drawText("Statement of unclaimed dividend (IEPF-2)", { x: 40, y: 560, size: 11, font });
    draw(
      [
        "Investor First",
        "Investor Middle",
        "Investor Last",
        "Folio No.",
        "Investment",
        "Amount",
        "Proposed date of",
      ],
      520,
    );
    draw(["Name", "Name", "Name", "", "Type", "transferred", "transfer to IEPF"], 510);
    draw(
      ["Zarina", "", "Wadia", "MRF0000771", "Amount for unclaimed", "1250.00", "12-Sep-2031"],
      480,
    );
    draw(["", "", "", "", "and unpaid dividend", "", ""], 470);
    draw(
      ["Bhupinder", "", "Sodhi", "MRF0000772", "Amount for unclaimed", "640.00", "12-Sep-2031"],
      450,
    );
    const pdf = Buffer.from(await doc.save());
    const up = await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("companySlug", "mrf-limited")
      .attach("file", pdf, { filename: "mrf-iepf2.pdf", contentType: "application/pdf" })
      .expect(201);
    await app.get(JobQueueService).drain();
    const job = await request(http)
      .get(`/api/v1/admin/ingestion/${up.body.id}`)
      .set(auth("admin"))
      .expect(200);
    expect(job.body).toMatchObject({ status: "COMPLETED", totalRows: 2, insertedRows: 2 });
    for (const state of ["GOA", "ASSAM"]) {
      const res = await request(http)
        .get("/api/v1/search/unclaimed")
        .query({ lastName: "Wadia", state })
        .set(auth("analyst"))
        .expect(200);
      expect(res.body.results[0]).toMatchObject({
        investorFullName: "Zarina Wadia",
        state: "UNKNOWN",
        investmentType: "Amount for unclaimed and unpaid dividend",
        unclaimedDividendPaise: 125000,
      });
    }
  });

  it("rejects a file without a folio column at upload", async () => {
    await request(http)
      .post("/api/v1/admin/ingestion")
      .set(auth("admin"))
      .field("formType", "IEPF_2")
      .attach("file", Buffer.from("a,b\n1,2"), { filename: "bad.csv", contentType: "text/csv" })
      .expect(400);
  });
});

describe("bulk loader: partition rebuild", () => {
  it("rebuilds a state partition off-line, swaps it in, and merges a repeat load", async () => {
    const { bulkUpsertFolios, folioColumns, folioSearchColumns, keysFromEnv } =
      await import("@finsol/db");
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const company = await db.query("SELECT id FROM companies WHERE slug = 'itc-limited'");
    const before = await db.query(
      "SELECT count(*)::int AS n FROM unclaimed_folios WHERE state = 'GOA'",
    );
    const keys = keysFromEnv();
    const row = (first: string, last: string, folio: string, amount: number) => ({
      companyId: company.rows[0].id,
      investorFirstName: first,
      investorMiddleName: null,
      investorLastName: last,
      investorFullName: `${first} ${last}`,
      fatherOrSpouseName: null,
      addressLine: null,
      city: "Panaji",
      state: "GOA",
      pincode: null,
      ...folioColumns(folio, keys),
      certificateNumbers: null,
      originalShares: 0,
      postActionShares: 0,
      amountsByEvent: { "2020-08-01": amount },
      custodyStatus: "PHYSICAL_DORMANT",
      eventDate: new Date("2020-08-01"),
      transferFinancialYear: "2020-21",
      investmentType: null,
      sourceFilingSrn: null,
      ingestionJobId: null,
      fatherOrSpouseRaw: null,
      validationStatus: "VALID" as const,
      validationIssues: [],
      reviewStatus: "PUBLISHED" as const,
      sourceDocumentId: null,
      sourceRowIds: [],
      quantityBasis: "AMOUNT_ONLY",
      quantityEffectiveDate: null,
      ...folioSearchColumns({ first, last }),
    });
    const first = await bulkUpsertFolios(
      [row("Fernando", "Menezes", "ITC0000001", 120), row("Lourdes", "Pereira", "ITC0000002", 80)],
      { form: "IEPF_2", databaseUrl: process.env.DATABASE_URL, rebuildAbove: 0 },
    );
    expect(first).toMatchObject({ mode: "rebuild", inserted: 2, updated: 0, partitions: 1 });
    const again = await bulkUpsertFolios(
      [{ ...row("Fernando", "Menezes", "ITC0000001", 0), amountsByEvent: { "2021-08-01": 30 } }],
      { form: "IEPF_2", databaseUrl: process.env.DATABASE_URL, rebuildAbove: 0 },
    );
    expect(again).toMatchObject({ mode: "rebuild", inserted: 0, updated: 1 });
    const after = await db.query(
      "SELECT count(*)::int AS n, sum(unclaimed_dividend_amount)::text AS total FROM unclaimed_folios WHERE state = 'GOA' AND city = 'Panaji'",
    );
    const parts = await db.query(
      "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'unclaimed_folios'::regclass",
    );
    const goa = await db.query(
      "SELECT count(*)::int AS n FROM unclaimed_folios WHERE state = 'GOA'",
    );
    await db.end();
    expect(after.rows[0]).toEqual({ n: 2, total: "230.00" });
    expect(parts.rows[0].n).toBe(38);
    expect(goa.rows[0].n).toBe(before.rows[0].n + 2);
    const found = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Fernando Menezes", state: "GOA" })
      .set(auth("analyst"))
      .expect(200);
    expect(found.body.results[0]).toMatchObject({
      investorFullName: "Fernando Menezes",
      folioNumber: "ITC0000001",
      unclaimedDividendPaise: 15000,
    });
  });
});

describe("Pan-India isolation: namesakes never mix", () => {
  const A = "9876511111";
  const B = "9876522222";
  const NAME = "Rajesh Kumar Sharma";
  const tokenFor: Record<string, string> = {};
  const as = (p: string) => ({ authorization: `Bearer ${tokenFor[p]}` });
  let folioId: string;
  let folioName: string;
  let folioState: string;

  beforeAll(async () => {
    for (const phone of [A, B]) {
      await request(http)
        .post("/api/v1/auth/otp/request")
        .send({ phone, purpose: "LOGIN" })
        .expect(200);
      const res = await request(http)
        .post("/api/v1/auth/otp/verify")
        .send({
          phone,
          code: otp.lastCode(`+91${phone}`),
          name: NAME,
          email: `${phone}@example.in`,
        })
        .expect(200);
      tokenFor[phone] = res.body.token;
    }
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const free = await db.query(
      `SELECT id, investor_full_name, state::text FROM unclaimed_folios
       WHERE id NOT IN (SELECT folio_id FROM recovery_cases WHERE folio_id IS NOT NULL)
         AND id NOT IN (SELECT unnest(matched_folio_ids) FROM leads_and_inquiries)
         AND state <> 'UNKNOWN' LIMIT 1`,
    );
    await db.end();
    folioId = free.rows[0].id;
    folioName = free.rows[0].investor_full_name;
    folioState = free.rows[0].state;
  });

  it("gives namesakes different holder IDs and shows masked PINs", async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const ids = await db.query(
      `SELECT investor_cluster_id($1, 'Mohan Lal Sharma', '400001', 'Mumbai', 'MAHARASHTRA') AS a,
              investor_cluster_id($1, 'Suresh Sharma', '400001', 'Mumbai', 'MAHARASHTRA') AS b,
              investor_cluster_id($1, 'Mohan Lal Sharma', '411001', 'Pune', 'MAHARASHTRA') AS c,
              investor_cluster_id(' RAJESH KUMAR SHARMA ', 'mohan lal sharma', '400001', 'MUMBAI', 'MAHARASHTRA') AS d`,
      [NAME],
    );
    await db.end();
    const { a, b, c, d } = ids.rows[0];
    expect(new Set([a, b, c]).size).toBe(3); // different father, or different PIN and city
    expect(d).toBe(a); // same person, written differently
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "DELHI" })
      .expect(200);
    for (const r of res.body.results) {
      expect(r.investorClusterId).toMatch(/^[0-9a-f]{64}$/);
      if (r.pincodeMasked) expect(r.pincodeMasked).toMatch(/^\d{3}\*\*\*$/);
    }
  });

  it("searches all of India across every state partition", async () => {
    const india = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "ALL_INDIA" })
      .expect(200);
    expect(india.body.query.state).toBe("ALL_INDIA");
    const states = new Set(india.body.results.map((r: { state: string }) => r.state));
    expect(states.has("DELHI")).toBe(true);
    const delhi = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ lastName: "Agarwal", state: "DELHI" })
      .expect(200);
    expect(india.body.total).toBeGreaterThanOrEqual(delhi.body.total);
  });

  it("flags a second claimant on the same holding instead of mixing them", async () => {
    const claim = (p: string) =>
      request(http)
        .post("/api/v1/search/claim")
        .set(as(p))
        .send({
          folioIds: [folioId],
          relationshipToHolder: "LEGAL_HEIR",
          physicalCertStatus: "LOST",
          consent: true,
        })
        .expect(200);
    const first = await claim(A);
    expect(first.body.underReview).toBe(false);
    const second = await claim(B);
    expect(second.body.underReview).toBe(true);
    expect(second.body.leadId).not.toBe(first.body.leadId);
    const board = await request(http).get("/api/v1/crm/board").set(auth("analyst")).expect(200);
    const leads = board.body.columns.flatMap((c: { items: { id: string }[] }) => c.items);
    expect(leads.find((l: { id: string }) => l.id === second.body.leadId).reviewAlert).toBe(
      "DUPLICATE_CLAIMANT_REVIEW",
    );

    // Both claimants are now in review; nothing is released until a person resolves it.
    const boardAfter = await request(http)
      .get("/api/v1/crm/board")
      .set(auth("analyst"))
      .expect(200);
    const allLeads = boardAfter.body.columns.flatMap((c: { items: { id: string }[] }) => c.items);
    expect(allLeads.find((l: { id: string }) => l.id === first.body.leadId).reviewAlert).toBe(
      "DUPLICATE_CLAIMANT_REVIEW",
    );
    const release = (body: Record<string, unknown>) =>
      request(http)
        .post(`/api/v1/crm/leads/${first.body.leadId}/release-folios`)
        .set(auth("analyst"))
        .send({
          folioIds: [folioId],
          reason: "Death certificate and succession papers checked.",
          ...body,
        });
    await release({}).expect(409);
    await request(http)
      .patch(`/api/v1/crm/leads/${first.body.leadId}`)
      .set(auth("analyst"))
      .send({ clearReviewAlert: true })
      .expect(200);
    // Still contested by B's open request: the outcome of the review must be recorded.
    await release({}).expect(409);
    // The analyst releases the folio to A only: B, same name, still sees it masked.
    await release({
      competingClaimReview: "Second claimant could not show a link to the holder; A verified.",
    }).expect(201);
    const view = async (p: string) =>
      (
        await request(http)
          .get("/api/v1/search/unclaimed")
          .query({ fullName: folioName, state: folioState })
          .set(as(p))
          .expect(200)
      ).body.results.find((r: { id: string }) => r.id === folioId);
    expect((await view(A)).folioReleased).toBe(true);
    const seenByB = await view(B);
    expect(seenByB.folioReleased).toBe(false);
    expect(seenByB.folioNumber).toContain("***");

    // A's case opens; B's flagged lead cannot become a case until reviewed.
    const caseA = await request(http)
      .post(`/api/v1/crm/leads/${first.body.leadId}/convert`)
      .set(auth("analyst"))
      .send({ folioId, scenarioType: "DECEASED_TRANSMISSION" })
      .expect(201);
    await request(http)
      .post(`/api/v1/crm/leads/${second.body.leadId}/convert`)
      .set(auth("analyst"))
      .send({ folioId, scenarioType: "DECEASED_TRANSMISSION" })
      .expect(409);

    // B can reach nothing of A's: the case, its list entry, mandate or documents.
    const code = caseA.body.caseCode;
    await request(http).get(`/api/v1/cases/${code}`).set(as(B)).expect(404);
    await request(http).get(`/api/v1/cases/${code}/mandate`).set(as(B)).expect(404);
    await request(http).get(`/api/v1/cases/${code}/documents/PAN/file`).set(as(B)).expect(404);
    const listB = await request(http).get("/api/v1/cases").set(as(B)).expect(200);
    expect(listB.body.map((c: { caseCode: string }) => c.caseCode)).not.toContain(code);
    const listA = await request(http).get("/api/v1/cases").set(as(A)).expect(200);
    expect(listA.body.map((c: { caseCode: string }) => c.caseCode)).toContain(code);
  });

  it("puts two simultaneous claims on one record into review (no race)", async () => {
    const C = "9876533333";
    const D = "9876544444";
    for (const phone of [C, D]) {
      await request(http)
        .post("/api/v1/auth/otp/request")
        .send({ phone, purpose: "LOGIN" })
        .expect(200);
      const res = await request(http)
        .post("/api/v1/auth/otp/verify")
        .send({
          phone,
          code: otp.lastCode(`+91${phone}`),
          name: NAME,
          email: `${phone}@example.in`,
        })
        .expect(200);
      tokenFor[phone] = res.body.token;
    }
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const free = await db.query(
      `SELECT id FROM unclaimed_folios
       WHERE id NOT IN (SELECT folio_id FROM recovery_cases WHERE folio_id IS NOT NULL)
         AND id NOT IN (SELECT unnest(matched_folio_ids) FROM leads_and_inquiries)
       LIMIT 1`,
    );
    const target = free.rows[0].id as string;
    const claim = (p: string) =>
      request(http)
        .post("/api/v1/search/claim")
        .set(as(p))
        .send({
          folioIds: [target],
          relationshipToHolder: "LEGAL_HEIR",
          physicalCertStatus: "AVAILABLE",
          consent: true,
        })
        .expect(200);
    const [a, b] = await Promise.all([claim(C), claim(D)]);
    // Exactly one arrived second and saw the other; both requests are now in review.
    expect([a.body.underReview, b.body.underReview].sort()).toEqual([false, true]);
    const flags = await db.query(
      "SELECT count(*)::int AS n FROM leads_and_inquiries WHERE $1 = ANY(matched_folio_ids) AND review_alert IS NOT NULL",
      [target],
    );
    await db.end();
    expect(flags.rows[0].n).toBe(2);
    // Neither response names or hints at the other claimant.
    for (const r of [a, b]) expect(JSON.stringify(r.body)).not.toMatch(/9876533333|9876544444/);
  });

  it("refuses unauthorised direct requests for records, imports and reviews", async () => {
    await request(http).get("/api/v1/admin/ingestion/coverage").set(as(A)).expect(403);
    await request(http).get("/api/v1/admin/ingestion/quarantine").set(as(A)).expect(403);
    await request(http)
      .post(`/api/v1/crm/leads/00000000-0000-4000-8000-000000000000/release-folios`)
      .set(as(A))
      .send({ folioIds: [folioId], reason: "I would like to see it please." })
      .expect(403);
    await request(http)
      .post("/api/v1/cases/RC-2026-1001/release-folio")
      .set(as(A))
      .send({ reason: "I would like to see it please." })
      .expect(403);
    await request(http).get("/api/v1/cases/RC-2026-1001").set(as(A)).expect(404);
  });

  it("enforces the same isolation in Postgres row-level security", async () => {
    await request(http)
      .post("/api/v1/valuation/report")
      .set(as(A))
      .send({
        holdings: [
          { symbol: "RELIANCE", exchange: "NSE", purchaseYear: 1999, originalShares: 100 },
        ],
      })
      .expect(200);
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const ids = await db.query("SELECT phone, id FROM users WHERE phone = ANY($1)", [
      [`+91${A}`, `+91${B}`],
    ]);
    const idOf = Object.fromEntries(ids.rows.map((r) => [r.phone, r.id]));
    const visible = async (userId: string) => {
      await db.query("BEGIN");
      await db.query("SET LOCAL ROLE finsol_app_client");
      await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const r = await db.query(
        `SELECT
        (SELECT count(*)::int FROM recovery_cases WHERE client_user_id = $1) AS cases_a,
        (SELECT count(*)::int FROM valuation_reports WHERE user_id = $1) AS reports_a,
        (SELECT count(*)::int FROM leads_and_inquiries WHERE phone = $2) AS leads_a,
        (SELECT count(*)::int FROM case_documents d JOIN recovery_cases c ON c.id = d.case_id
          WHERE c.client_user_id = $1) AS docs_a`,
        [idOf[`+91${A}`], `+91${A}`],
      );
      await db.query("ROLLBACK");
      return r.rows[0];
    };
    const forA = await visible(idOf[`+91${A}`]);
    const forB = await visible(idOf[`+91${B}`]);
    await db.end();
    expect(forA).toMatchObject({ cases_a: 1, reports_a: 1, leads_a: 1 });
    expect(forB).toEqual({ cases_a: 0, reports_a: 0, leads_a: 0, docs_a: 0 });
  });
});

describe("Pan-India drop folder and legacy ISINs", () => {
  it("loads a BSE scrip list and maps a pre-split ISIN to the right company", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createPrismaClient, processFile } = await import("@finsol/db");
    const dir = await mkdtemp(join(tmpdir(), "drop-"));
    const scrips = join(dir, "ListOfScrips.csv");
    await writeFile(
      scrips,
      [
        "Security Code,Issuer Name,Security Id,Security Name,Status,Group,Face Value,ISIN No,Industry,Instrument",
        "500034,Bajaj Finance Limited,BAJFINANCE,BAJAJ FINANCE LTD.,Active,A ,1.00,INE296A01032,NBFC,Equity",
        "500325,Reliance Industries Ltd,RELIANCE,RELIANCE INDUSTRIES LTD.,Active,A ,10.00,INE002A01018,Refineries,Equity",
      ].join("\n"),
    );
    const statement = join(dir, "iepf2-old.csv");
    await writeFile(
      statement,
      [
        "Investor First Name,Investor Middle Name,Investor Last Name,Father/Husband First Name,Address,Country,State,District,Pin Code,Folio Number,ISIN,Investment Type,Amount transferred,Proposed Date of transfer to IEPF",
        "Shobha,,Kulkarni,Vasant,Shaniwar Peth,India,Maharashtra,Pune,411030,BFL0000123,INE296A01024,Amount for unclaimed and unpaid dividend,450,01-Sep-2019",
      ].join("\n"),
    );
    const db = createPrismaClient(process.env.DATABASE_URL);
    try {
      expect(await processFile(db, scrips)).toMatchObject({ kind: "bse-scrips", equities: 2 });
      expect(await processFile(db, statement)).toMatchObject({ kind: "statement", inserted: 1 });
    } finally {
      await db.$disconnect();
    }
    const found = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Shobha Kulkarni", state: "MAHARASHTRA" })
      .set(auth("analyst"))
      .expect(200);
    expect(found.body.results[0]).toMatchObject({
      companyName: "Bajaj Finance Limited",
      pincodeMasked: "411***",
      unclaimedDividendPaise: 45000,
    });
    const bse = await request(http)
      .get("/api/v1/market/equities")
      .query({ q: "500034" })
      .expect(200);
    expect(bse.body.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ exchange: "BSE", symbol: "500034" })]),
    );
  });
});

describe("audit log", () => {
  it("is append-only, even for the table owner", async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const count = await db.query("SELECT count(*)::int AS n FROM audit_events");
    expect(count.rows[0].n).toBeGreaterThan(5);
    await expect(db.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
    await db.end();
  });
});

describe("companies and stats", () => {
  it("serves a company page payload with actions and records", async () => {
    const res = await request(http).get("/api/v1/companies/wipro-limited").expect(200);
    expect(res.body).toMatchObject({ name: "Wipro Limited", tickerNse: "WIPRO" });
    // Contacts and identifiers stay with staff.
    for (const key of ["cin", "isin", "rta", "nodalOfficer", "irPageUrl", "statutoryBasis"])
      expect(res.body).not.toHaveProperty(key);
    expect(
      res.body.corporateActions.filter((a: { actionType: string }) => a.actionType === "BONUS"),
    ).toHaveLength(7);
    expect(res.body.corporateActions.every((a: { source: string | null }) => a.source)).toBe(true);
    await request(http).get("/api/v1/admin/companies/wipro-limited").expect(401);
    await request(http)
      .get("/api/v1/admin/companies/wipro-limited")
      .set(auth("sunita"))
      .expect(403);
    const internal = await request(http)
      .get("/api/v1/admin/companies/wipro-limited")
      .set(auth("analyst"))
      .expect(200);
    expect(internal.body).toMatchObject({
      isin: "INE075A01022",
      rta: { name: "KFIN", label: "KFin Technologies Limited" },
      nodalOfficer: {
        name: "Mr. M Sanaulla Khan (Company Secretary)",
        emails: ["sanaulla.khan@wipro.com", "iepf.nodalofficer@wipro.com"],
        phone: "+91 80 28440011",
      },
    });
    const sbi = await request(http)
      .get("/api/v1/admin/companies/state-bank-of-india")
      .set(auth("analyst"))
      .expect(200);
    expect(sbi.body.cin).toBeNull();
    expect(sbi.body.statutoryBasis).toContain("State Bank of India Act, 1955");
    const ril = await request(http)
      .get("/api/v1/admin/companies/reliance-industries-limited")
      .set(auth("analyst"))
      .expect(200);
    expect(ril.body.nodalOfficer.deputies).toHaveLength(2);
    expect(ril.body.rta).toMatchObject({
      email: "rilinvestor@kfintech.com",
      phone: "1800 309 4001 (toll-free)",
    });
    await request(http).get("/api/v1/companies/no-such-co").expect(404);
    const stats = await request(http).get("/api/v1/stats").expect(200);
    expect(stats.body.companies).toBe(15);
    expect(stats.body.folios).toBeGreaterThan(10);
  });
});

describe("audit regressions: search contract, quarantine and sign-in status", () => {
  it("reports coverage, limits and match classes with every search, and never shows unknown shares as zero", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Ramesh Kumar Agarwal", state: "DELHI" })
      .expect(200);
    expect(res.body).toMatchObject({ limit: 50, truncated: false });
    expect(res.body.coverage.holderRecords).toBeGreaterThan(0);
    // Company names stay masked for the public, including in the coverage block.
    expect(res.body.coverage.companiesWithRecords).toEqual([]);
    expect(res.body.coverage.companiesWithRecordsCount).toBeGreaterThan(0);
    const classes = new Set(res.body.results.map((r: { matchClass: string }) => r.matchClass));
    for (const c of classes) expect(["exact", "partial", "variant"]).toContain(c);
    expect(res.body.results[0].matchClass).toBe("exact");

    const noMatch = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Zzyzx Qwertyuiop", state: "ALL_INDIA" })
      .expect(200);
    expect(noMatch.body.total).toBe(0);
    expect(noMatch.body.coverage.holderRecords).toBeGreaterThan(0);
  });

  it("searches a single typed word as a surname too, not only as a first name", async () => {
    const res = await request(http)
      .get("/api/v1/search/unclaimed")
      .query({ fullName: "Agarwal", state: "DELHI" })
      .expect(200);
    const names = res.body.results.map((r: { investorFullName: string }) => r.investorFullName);
    expect(names).toContain("Ramesh Kumar Agarwal");
    expect(
      res.body.results.every((r: { state: string }) => ["DELHI", "UNKNOWN"].includes(r.state)),
    ).toBe(true);
  });

  it("keeps quarantined records out of search until a reviewer publishes them", async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const row = (
      await db.query(
        "SELECT id, investor_full_name, state::text AS state FROM unclaimed_folios WHERE review_status = 'PUBLISHED' AND state <> 'UNKNOWN' LIMIT 1",
      )
    ).rows[0];
    const find = async () =>
      (
        await request(http)
          .get("/api/v1/search/unclaimed")
          .query({ fullName: row.investor_full_name, state: row.state })
          .set(auth("admin"))
          .expect(200)
      ).body.results.some((r: { id: string }) => r.id === row.id);
    expect(await find()).toBe(true);
    await db.query("UPDATE unclaimed_folios SET review_status = 'QUARANTINED' WHERE id = $1", [
      row.id,
    ]);
    expect(await find()).toBe(false);
    await db.query("UPDATE unclaimed_folios SET review_status = 'PUBLISHED' WHERE id = $1", [
      row.id,
    ]);
    await db.end();
  });

  it("says whether sign-in codes can be sent, and never returns a code", async () => {
    const status = await request(http).get("/api/v1/auth/otp/status").expect(200);
    expect(status.body).toEqual({ available: true, channel: "sms", message: null });
    const sent = await request(http)
      .post("/api/v1/auth/otp/request")
      .send({ phone: "9876599999", purpose: "LOGIN" })
      .expect(200);
    expect(sent.body).not.toHaveProperty("testCode");
    expect(Object.keys(sent.body).sort()).toEqual(
      ["channel", "expiresAt", "phone", "resendAfterSeconds"].sort(),
    );
  });

  it("serves the admin coverage report as aggregates only", async () => {
    const res = await request(http)
      .get("/api/v1/admin/ingestion/coverage")
      .set(auth("admin"))
      .expect(200);
    expect(res.body.holderRecords).toBeGreaterThan(0);
    expect(res.body.companyProfiles).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    // No holder names or folio numbers in the dashboard payload.
    expect(text).not.toMatch(/Ramesh|Agarwal|RIL0012345621/);
  });
});

describe("assisted traces", () => {
  const body = {
    requestId: randomUUID(),
    holderName: "Trace Test Holder",
    scope: "ALL_INDIA",
    relationship: "SELF",
    oldCity: "Test town",
    consent: true,
  };
  let traceId: string;
  it("requires a session and explicit consent", async () => {
    await request(http).post("/api/v1/traces").send(body).expect(401);
    await request(http)
      .post("/api/v1/traces")
      .set(auth("sunita"))
      .send({ ...body, consent: false })
      .expect(400);
  });
  it("saves encrypted details, server coverage and one reference per retry", async () => {
    const first = await request(http)
      .post("/api/v1/traces")
      .set(auth("sunita"))
      .send(body)
      .expect(201);
    traceId = first.body.id;
    const again = await request(http)
      .post("/api/v1/traces")
      .set(auth("sunita"))
      .send(body)
      .expect(201);
    expect(again.body.id).toBe(traceId);
    expect(first.body.reference).toMatch(/^FIN-TRC-[A-HJ-NP-Z2-9]{6}$/);
    expect(first.body).not.toHaveProperty("detailsEnc");
    const stored = await app
      .get(PrismaService)
      .client.traceRequest.findUniqueOrThrow({ where: { id: traceId } });
    expect(stored.detailsEnc).toMatch(/^v1:/);
    expect(stored.holderName).not.toContain(body.holderName);
    expect(JSON.stringify(stored.indexSnapshot)).toContain("Index coverage at request time");
  });
  it("takes contact details only from the signed-in account, whose mobile was OTP-verified", async () => {
    // Unverified, typed-in contact numbers are refused.
    await request(http)
      .post("/api/v1/traces")
      .set(auth("sunita"))
      .send({ ...body, requestId: randomUUID(), claimantMobile: "9999999999" })
      .expect(400);
    const detail = await request(http)
      .get(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .expect(200);
    const prisma = app.get(PrismaService).client;
    const trace = await prisma.traceRequest.findUniqueOrThrow({ where: { id: traceId } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: trace.userId! } });
    expect(detail.body.details.contact).toMatchObject({
      phone: account.phone,
      phoneVerifiedBy: "LOGIN_OTP",
    });
  });
  it("isolates members and protects staff access", async () => {
    const own = await request(http).get("/api/v1/traces").set(auth("sunita")).expect(200);
    expect(own.body.some((r: { id: string }) => r.id === traceId)).toBe(true);
    const other = await request(http).get("/api/v1/traces").set(auth("meera")).expect(200);
    expect(other.body.some((r: { id: string }) => r.id === traceId)).toBe(false);
    await request(http)
      .post(`/api/v1/traces/${traceId}/withdraw`)
      .set(auth("meera"))
      .send({})
      .expect(404);
    await request(http).get(`/api/v1/admin/traces/${traceId}`).set(auth("meera")).expect(403);
  });
  it("requires recorded source evidence before closure", async () => {
    await request(http)
      .patch(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .send({ status: "RTA_ARCHIVE_SEARCHED" })
      .expect(400);
    await request(http)
      .patch(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .send({ status: "CLOSED_FOUND" })
      .expect(400);
    await request(http)
      .post(`/api/v1/admin/traces/${traceId}/checks`)
      .set(auth("analyst"))
      .send({
        source: "https://issuer.example/unclaimed",
        authorisation: "Public statutory source reviewed for this request",
        outcome: "MATCH_FOUND",
        note: "A candidate needing identity verification",
      })
      .expect(201);
    const detail = await request(http)
      .get(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .expect(200);
    expect(detail.body.holderName).toBe(body.holderName);
    expect(detail.body.checks[0].note).toBe("A candidate needing identity verification");
    await request(http)
      .patch(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .send({ status: "CLOSED_FOUND" })
      .expect(200);
  });
  it("withdrawal prevents further checks and reopening", async () => {
    await request(http)
      .post(`/api/v1/traces/${traceId}/withdraw`)
      .set(auth("sunita"))
      .send({})
      .expect(201);
    await request(http)
      .post(`/api/v1/admin/traces/${traceId}/checks`)
      .set(auth("analyst"))
      .send({
        source: "https://issuer.example/list",
        authorisation: "Previously authorised review",
        outcome: "NO_MATCH",
      })
      .expect(400);
    await request(http)
      .patch(`/api/v1/admin/traces/${traceId}`)
      .set(auth("analyst"))
      .send({ status: "OPEN" })
      .expect(400);
  });
});

describe("durable acquisition queue", () => {
  it("recovers an expired lease and parks an exhausted job", async () => {
    const { work } = await import("../../../packages/db/dist/acquisition/worker.js");
    const prisma = app.get(PrismaService);
    const pool = new pg.Pool({ connectionString: prisma.databaseUrl });
    const recover = randomUUID(),
      exhausted = randomUUID();
    try {
      await pool.query(
        `INSERT INTO acquisition_jobs (id, kind, target_id, status, attempts, locked_by, locked_until)
        VALUES ($1, 'DISCOVER', $3, 'RUNNING', 1, 'stopped-worker', now() - interval '1 minute'),
               ($2, 'DISCOVER', $4, 'RUNNING', 4, 'stopped-worker', now() - interval '1 minute')`,
        [recover, exhausted, randomUUID(), randomUUID()],
      );
      const stats = await work(
        {
          pool,
          db: prisma.client,
          keys: prisma.fieldKeys,
          databaseUrl: prisma.databaseUrl,
          log: () => {},
        },
        { concurrency: 2, deadline: Date.now() + 5000, kinds: ["DISCOVER"] },
      );
      expect(stats["DISCOVER:missing"]).toBe(1);
      const rows = (
        await pool.query(
          `SELECT id, status, attempts, locked_by FROM acquisition_jobs WHERE id = ANY($1)`,
          [[recover, exhausted]],
        )
      ).rows;
      expect(rows.find((r) => r.id === recover)).toMatchObject({
        status: "DONE",
        attempts: 2,
        locked_by: null,
      });
      expect(rows.find((r) => r.id === exhausted)).toMatchObject({
        status: "DEAD",
        attempts: 4,
        locked_by: null,
      });
    } finally {
      await pool.end();
    }
  });
});

/** Text of a PDF, one string, with pdf.js's line runs joined by spaces. */
async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) if ("str" in item) parts.push(item.str);
  }
  return parts.join(" ").replace(/\s+/g, " ");
}

describe("intake without a sign-in code", () => {
  const holdings = [
    { symbol: "ITC", exchange: "NSE", purchaseYear: 2000, originalShares: 10, manualPrice: 400 },
  ];
  const contact = {
    name: "Guest Visitor",
    phone: "98765 01234",
    email: "Guest.Visitor@example.in",
  };
  const db = () => new pg.Client({ connectionString: process.env.DATABASE_URL });
  const setSms = (available: boolean) =>
    Object.defineProperty(otp, "available", { value: available, configurable: true });
  const pdf = (r: request.Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

  it("issues a Valuation Dossier to a visitor who leaves contact details, marked unverified", async () => {
    await request(http)
      .post("/api/v1/valuation/report/guest")
      .send({ holdings, contact })
      .expect(400); // consent is required
    await request(http)
      .post("/api/v1/valuation/report/guest")
      .send({ holdings, contact: { ...contact, phone: "12345" }, consent: true })
      .expect(400);
    const res = await pdf(
      request(http)
        .post("/api/v1/valuation/report/guest")
        .send({ holdings, contact, consent: true }),
    ).expect(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const text = await pdfText(res.body as Buffer);
    expect(text).toContain("Prepared for Guest Visitor");
    expect(text).toContain("Contact details as given; a Finsol analyst confirms them by phone");
    expect(text).toContain(
      "Success-Based Fee: Custom (Zero Upfront — Quoted per Engagement Letter)",
    );

    const c = db();
    await c.connect();
    const report = await c.query(
      `SELECT r.user_id, r.contact_verification, l.phone, l.email, l.phone_otp_verified, l.intake_source, l.search_context
         FROM valuation_reports r JOIN leads_and_inquiries l ON l.id = r.lead_id
        WHERE r.report_code = $1`,
      [res.headers["x-report-code"]],
    );
    await c.end();
    expect(report.rows[0]).toMatchObject({
      user_id: null,
      contact_verification: "PENDING_CALL_VERIFICATION",
      phone: "+919876501234",
      email: "guest.visitor@example.in",
      phone_otp_verified: false,
      intake_source: "VALUATION_DOSSIER",
    });
    expect(report.rows[0].search_context.contactVerification).toBe("PENDING_CALL_VERIFICATION");
  });

  it("accepts a Deeper Trace without a code only while codes cannot be texted", async () => {
    const trace = {
      requestId: randomUUID(),
      holderName: "Late Shri Guest Holder",
      scope: "ALL_INDIA",
      relationship: "LEGAL_HEIR",
      certificateStatus: "LOST",
      consent: true,
      contact,
    };
    await request(http).post("/api/v1/traces/guest").send(trace).expect(409);
    const status = await request(http).get("/api/v1/intake/status").expect(200);
    expect(status.body).toMatchObject({ smsSignIn: true, guestDossier: true, guestTrace: false });

    setSms(false);
    try {
      expect((await request(http).get("/api/v1/intake/status")).body.guestTrace).toBe(true);
      await request(http)
        .post("/api/v1/traces/guest")
        .send({ ...trace, consent: false })
        .expect(400);
      const res = await request(http).post("/api/v1/traces/guest").send(trace).expect(201);
      expect(res.body.reference).toMatch(/^FIN-TRC-[A-Z2-9]{6}$/);
      expect(res.body).toMatchObject({
        status: "PENDING_AUDIT",
        contactVerification: "PENDING_CALL_VERIFICATION",
      });
      // A retried submission returns the same request.
      const again = await request(http).post("/api/v1/traces/guest").send(trace).expect(201);
      expect(again.body.reference).toBe(res.body.reference);

      const c = db();
      await c.connect();
      const row = await c.query(
        `SELECT t.user_id, t.contact_verification, t.holder_name, l.relationship_to_holder, l.physical_cert_status, l.intake_source
           FROM trace_requests t JOIN leads_and_inquiries l ON l.id = t.lead_id WHERE t.reference = $1`,
        [res.body.reference],
      );
      await c.end();
      expect(row.rows[0]).toMatchObject({
        user_id: null,
        contact_verification: "PENDING_CALL_VERIFICATION",
        relationship_to_holder: "LEGAL_HEIR",
        physical_cert_status: "LOST",
        intake_source: "DEEPER_TRACE",
      });
      expect(row.rows[0].holder_name).not.toContain("Guest Holder"); // encrypted at rest

      // Staff see it, flagged for a verification call.
      const list = await request(http).get("/api/v1/admin/traces").set(auth("analyst")).expect(200);
      const item = list.body.items.find(
        (t: { reference: string }) => t.reference === res.body.reference,
      );
      expect(item.contactVerification).toBe("PENDING_CALL_VERIFICATION");
    } finally {
      setSms(true);
    }
  });

  it("takes a verification-call request and never signs anyone in", async () => {
    const res = await request(http)
      .post("/api/v1/intake/callback")
      .send({ contact: { ...contact, phone: "9876501235" }, consent: true })
      .expect(200);
    expect(res.body).toEqual({
      status: "RECEIVED",
      contactVerification: "PENDING_CALL_VERIFICATION",
    });
    expect(res.body.token).toBeUndefined();
  });
});

describe("stats: defensible recoverable value", () => {
  it("splits share value from listed amounts and leads with verified records", async () => {
    const s = (await request(http).get("/api/v1/stats").expect(200)).body;
    expect(s.verifiedRecords).toBe(s.folios);
    expect(s.recoverableValuePaise).toBe(s.shareValuePaise + s.unclaimedAmountsPaise);
    expect(s.estimatedValuePaise).toBe(s.recoverableValuePaise);
  });
});
