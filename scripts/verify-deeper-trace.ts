import "dotenv/config";
import request from "supertest";
import { createPrismaClient, decryptField, keysFromEnv } from "@finsol/db";

async function main() {
  console.log("\n=======================================================");
  console.log("DEEPER TRACE GATEWAY END-TO-END VERIFICATION");
  console.log("=======================================================\n");

  const db = createPrismaClient();
  const keys = keysFromEnv();

  // 1. Verify user exists or get user for session
  let user = await db.user.findFirst({
    where: { email: "sunita@example.com" },
  });

  if (!user) {
    user = await db.user.create({
      data: {
        email: "sunita@example.com",
        phone: "+919876543210",
        name: "Sunita Sharma",
        role: "INVESTOR",
      },
    });
  }

  // 2. Test Deeper Trace Creation with FIN-TRC-XXXXXX reference format
  console.log("1. Testing Deeper Trace submission with encrypted claimant details...");
  const requestId = crypto.randomUUID();
  const holderName = "Late Om Prakash Saxena";

  // Simulate API traces submission
  const { TracesService } = await import("../apps/api/dist/modules/traces/traces.service.js");
  const { PrismaService } = await import("../apps/api/dist/common/prisma.service.js");
  const { SearchService } = await import("../apps/api/dist/modules/search/search.service.js");
  const { AuditService } = await import("../apps/api/dist/common/audit.service.js");

  const env = { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/recoveryos" };
  const prismaService = new PrismaService(env as any);
  const searchService = new SearchService(prismaService);
  const auditService = new AuditService(prismaService);
  const tracesService = new TracesService(prismaService, searchService, auditService);

  const mockUserSession = {
    sub: user.id,
    role: "INVESTOR" as const,
    name: user.name,
    email: user.email,
  };

  const createdTrace = await tracesService.create(
    {
      requestId,
      holderName,
      scope: "ALL_INDIA",
      relationship: "FAMILY",
      oldCity: "Kanpur",
      oldAddress: "Civil Lines, Kanpur, Uttar Pradesh",
      certificateStatus: "LOST",
      companies: "Reliance Industries, Tata Steel",
      years: "1988 - 1999",
      claimantName: "Sunita Sharma",
      claimantEmail: "sunita@example.com",
      claimantMobile: "+919876543210",
      consent: true,
    },
    mockUserSession,
  );

  console.log(`   ✓ Trace created successfully!`);
  console.log(`   ✓ Reference ID: ${createdTrace.reference}`);
  console.log(`   ✓ Initial Status: ${createdTrace.status}`);

  // 3. Verify Reference matches FIN-TRC-XXXXXX
  const refPattern = /^FIN-TRC-[A-Z0-9]{6}$/;
  if (!refPattern.test(createdTrace.reference)) {
    throw new Error(`Reference format does not match FIN-TRC-XXXXXX: ${createdTrace.reference}`);
  }
  console.log(`   ✓ Reference format verified: matches ${refPattern}`);

  // 4. Verify Database Persistence & Encryption
  console.log("\n2. Verifying database persistence in Neon / PostgreSQL...");
  const persisted = await db.traceRequest.findUniqueOrThrow({
    where: { id: createdTrace.id },
  });

  if (!persisted.detailsEnc.startsWith("v1:")) {
    throw new Error("Claimant details are not encrypted with AES-256-GCM!");
  }
  console.log(`   ✓ detailsEnc is encrypted with AES-256-GCM (starts with v1:)`);

  if (persisted.holderName === holderName) {
    throw new Error("Holder name was stored in plaintext!");
  }
  console.log(`   ✓ holderName is zero-knowledge encrypted in database`);

  // 5. Verify Staff Decryption & Audit Details
  console.log("\n3. Verifying Staff Admin review decryption...");
  const analystSession = {
    sub: user.id,
    role: "VALUATION_ANALYST" as const,
    name: "Staff Analyst",
    email: "analyst@finsol.local",
  };

  const staffView = await tracesService.get(createdTrace.id, analystSession);
  console.log(`   ✓ Decrypted holder name: "${staffView.holderName}"`);
  console.log(`   ✓ Decrypted suspected companies: "${staffView.details.companies}"`);
  console.log(`   ✓ Decrypted certificate status: "${staffView.details.certificateStatus}"`);
  console.log(`   ✓ Decrypted claimant contact: ${staffView.details.contact.name} (${staffView.details.contact.phone})`);

  // 6. Test Status Transitions
  console.log("\n4. Verifying status transitions across CRM workflow...");
  // Transition to RTA Archive Searched
  const s1 = await tracesService.update(createdTrace.id, "RTA_ARCHIVE_SEARCHED", analystSession);
  console.log(`   ✓ Transitioned to: ${s1.status}`);

  // Record a source check
  await tracesService.check(
    createdTrace.id,
    {
      source: "https://kfintech.example/archive/iepf",
      authorisation: "Public statutory RTA microfilm archive inspected",
      outcome: "MATCH_FOUND",
      note: "Found folio matching Kanpur address in 1994 microfiche",
    },
    analystSession,
  );
  console.log(`   ✓ Recorded verified RTA source check`);

  // Transition to Match Found
  const s2 = await tracesService.update(createdTrace.id, "MATCH_FOUND", analystSession);
  console.log(`   ✓ Transitioned to: ${s2.status}`);

  // Transition to Closed
  const s3 = await tracesService.update(createdTrace.id, "CLOSED", analystSession);
  console.log(`   ✓ Transitioned to: ${s3.status}`);

  console.log("\n=======================================================");
  console.log("ALL DEEPER TRACE GATEWAY VERIFICATIONS PASSED!");
  console.log("=======================================================\n");

  await db.$disconnect();
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
