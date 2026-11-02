/**
 * Streaming importer against a disposable database (`recoveryos_stream_test`,
 * rebuilt from the migrations). Fixture holders are fictional test data and
 * exist only in this database. Needs the local Postgres: `npm run db:start`.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ExcelJS from "exceljs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptField, type FieldKeys } from "../src/crypto.js";
import { createPrismaClient, type PrismaClient } from "../src/index.js";
import { ingestStatement } from "../src/ingest-iepf.js";
import { readManifest, REGISTRAR_PATTERNS, rollbackBatch } from "../src/pan-india/engine.js";
import { ingestStatementStream } from "../src/stream-ingest.js";
import { openStatementStream } from "../src/stream-reader.js";

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const URL =
  process.env.STREAM_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54329/recoveryos_stream_test";
const KEYS: FieldKeys = { encryptionKey: Buffer.alloc(32, 7), hashKey: Buffer.alloc(32, 9) };

let db: PrismaClient;
let sql: pg.Client;
let dir: string;

const HEADERS = [
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
];
type Line = [string, string, string, string, string, string, string, string, string, string];
// first, last, relative first, relative last, address, state, pin, folio, amount, date
const LINES: Line[] = [
  [
    "TESTALPHA",
    "FIXTURE",
    "TESTSIRE",
    "FIXTURE",
    "1 Test Lane, Fixture Nagar",
    "Maharashtra",
    "400001",
    "TF0000001",
    "100.50",
    "01-OCT-2025",
  ],
  [
    "TESTBETA",
    "FIXTURE",
    "",
    "",
    "2 Test Lane",
    "Karnataka",
    "560001",
    "TF0000002",
    "40",
    "01-OCT-2025",
  ],
  [
    "TESTALPHA",
    "FIXTURE",
    "TESTSIRE",
    "FIXTURE",
    "1 Test Lane, Fixture Nagar",
    "Maharashtra",
    "400001",
    "TF0000001",
    "20.25",
    "01-OCT-2024",
  ],
  [
    "TESTGAMMA",
    "FIXTURE",
    "",
    "",
    "3 Test Lane",
    "Tamil Nadu",
    "600001",
    "TF0000003",
    "75",
    "01-OCT-2025",
  ],
  [
    "TESTALPHA",
    "FIXTURE",
    "TESTSIRE",
    "FIXTURE",
    "1 Test Lane, Fixture Nagar",
    "Maharashtra",
    "400001",
    "TF0000001",
    "9.25",
    "01-OCT-2025",
  ],
  [
    "TESTDELTA",
    "FIXTURE",
    "",
    "",
    "4 Test Lane\nSecond line",
    "Delhi",
    "110001",
    "TF0000004",
    "12",
    "01-OCT-2025",
  ],
  [
    "TESTBETA",
    "FIXTURE",
    "",
    "",
    "2 Test Lane",
    "Karnataka",
    "560001",
    "TF0000002",
    "60",
    "01-OCT-2023",
  ],
];
const row = (l: Line) => [
  l[0],
  "",
  l[1],
  l[2],
  "",
  l[3],
  l[4],
  "INDIA",
  l[5],
  "",
  l[6],
  l[7],
  "",
  "Amount for unclaimed and unpaid dividend",
  l[8],
  l[9],
];

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
async function writeCsv(path: string) {
  const out = [
    "Statement of unpaid and unclaimed amounts,,,",
    "",
    HEADERS.map(csvCell).join(","),
    ...LINES.map((l) => row(l).map(csvCell).join(",")),
    "Total,,,",
  ];
  await writeFile(path, out.join("\r\n"));
}
async function writeXlsx(path: string) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Instructions").addRow(["Read me first"]);
  const ws = wb.addWorksheet("Investor Details");
  ws.addRow(["Statement of unpaid and unclaimed amounts"]);
  ws.addRow([]);
  ws.addRow(HEADERS);
  for (const l of LINES) ws.addRow(row(l));
  await wb.xlsx.writeFile(path);
}

async function company(slug: string) {
  return (
    await db.company.create({
      data: {
        name: `Stream Test ${slug}`,
        slug,
        statutoryBasis: "Test fixture",
        nodalOfficerName: "",
        contactsSource: "test fixture",
      },
      select: { id: true },
    })
  ).id;
}
const holders = (companyId: string) =>
  sql
    .query<{
      investor_full_name: string;
      state: string;
      amounts_by_event: Record<string, number>;
      folio_number: string;
      ingestion_job_id: string | null;
    }>(
      `SELECT investor_full_name, state::text, amounts_by_event, folio_number, ingestion_job_id
         FROM unclaimed_folios WHERE company_id = $1 ORDER BY investor_full_name`,
      [companyId],
    )
    .then((r) => r.rows);

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const name = new globalThis.URL(URL).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error("The stream test database name must end in _test.");
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, DATABASE_URL: URL },
    stdio: "pipe",
  });
  db = createPrismaClient(URL);
  sql = new pg.Client({ connectionString: URL });
  await sql.connect();
  dir = await mkdtemp(join(tmpdir(), "finsol-stream-"));
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  await sql?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("streaming reader", () => {
  it("finds the header below a title block and keeps quoted commas and line breaks", async () => {
    const p = join(dir, "reader.csv");
    await writeCsv(p);
    const s = await openStatementStream(p);
    expect(s.headerRow).toBe(3);
    const rows = [];
    for await (const r of s.rows) rows.push(r);
    expect(rows[0]!.cells[6]).toBe("1 Test Lane, Fixture Nagar");
    expect(rows[5]!.cells[6]).toBe("4 Test Lane\nSecond line");
  });

  it("skips sheets without a header row in a workbook", async () => {
    const p = join(dir, "reader.xlsx");
    await writeXlsx(p);
    const s = await openStatementStream(p);
    expect(s.sheet).toBe("Investor Details");
  });
});

describe("ingestStatementStream", () => {
  it("groups a holder's lines across chunk boundaries exactly as the in-memory importer does", async () => {
    const csv = join(dir, "group.csv");
    const xlsx = join(dir, "group.xlsx");
    await writeCsv(csv);
    await writeXlsx(xlsx);
    const streamed = await company("stream-a");
    const inMemory = await company("memory-a");
    const source = { url: "https://example.test/iepf2.csv", retrievedAt: new Date("2026-11-02") };

    // chunkSize 2 splits TESTALPHA's three lines and TESTBETA's two across chunks.
    const r = await ingestStatementStream(db, KEYS, csv, {
      companyId: streamed,
      chunkSize: 2,
      databaseUrl: URL,
      source,
    });
    expect(r.totalRows).toBe(7);
    expect(r.chunks).toBe(4);
    expect(r.insertedRows).toBe(4);
    const { readFile } = await import("node:fs/promises");
    await ingestStatement(
      db,
      KEYS,
      { buffer: await readFile(xlsx), fileName: "group.xlsx" },
      { companyId: inMemory, databaseUrl: URL },
    );

    const a = await holders(streamed);
    const b = await holders(inMemory);
    expect(a.map((h) => [h.investor_full_name, h.state, h.amounts_by_event])).toEqual(
      b.map((h) => [h.investor_full_name, h.state, h.amounts_by_event]),
    );
    const alpha = a.find((h) => h.investor_full_name.startsWith("TESTALPHA"))!;
    expect(alpha.amounts_by_event).toEqual({ "2025-10-01": 109.75, "2024-10-01": 20.25 });
    expect(decryptField(alpha.folio_number, KEYS)).toBe("TF0000001");

    // Every line is kept as an encrypted source row, linked to its holder.
    const rows = await sql.query(
      `SELECT count(*)::int n, count(folio_id)::int linked FROM source_rows WHERE source_document_id = $1`,
      [r.sourceDocumentId],
    );
    expect(rows.rows[0]).toEqual({ n: 7, linked: 7 });
  });

  it("skips a file already imported with the same reader", async () => {
    const csv = join(dir, "group.csv");
    const c = await company("stream-b");
    const source = { url: "https://example.test/iepf2.csv", retrievedAt: new Date("2026-11-02") };
    const first = await ingestStatementStream(db, KEYS, csv, {
      companyId: c,
      databaseUrl: URL,
      source,
    });
    expect(first.alreadyImported).toBe(true); // same checksum as the previous test's file
    expect((await holders(c)).length).toBe(0);
  });

  it("validates without writing on a dry run", async () => {
    const p = join(dir, "dry.csv");
    await writeCsv(p);
    await writeFile(p, `${await (await import("node:fs/promises")).readFile(p, "utf8")}\r\n`);
    const c = await company("stream-dry");
    const r = await ingestStatementStream(db, KEYS, p, { companyId: c, dryRun: true });
    expect(r.validRows + r.warningRows).toBe(7);
    expect((await holders(c)).length).toBe(0);
  });
});

describe("rollbackBatch", () => {
  it("deletes what the batch created, keeps what existed before, and allows a re-import", async () => {
    const p = join(dir, "rollback.csv");
    await writeCsv(p);
    await writeFile(p, `${await (await import("node:fs/promises")).readFile(p, "utf8")}\r\n\r\n`);
    const c = await company("stream-rollback");
    const source = {
      url: "https://example.test/rollback.csv",
      retrievedAt: new Date("2026-11-02"),
    };
    const job = async () =>
      (
        await db.ingestionJob.create({
          data: {
            formType: "IEPF_2",
            fileName: "rollback.csv",
            storageKey: "test",
            status: "PROCESSING",
            startedAt: new Date(),
          },
          select: { id: true },
        })
      ).id;
    const j1 = await job();
    await ingestStatementStream(db, KEYS, p, { companyId: c, jobId: j1, databaseUrl: URL, source });
    expect((await holders(c)).length).toBe(4);

    const res = await rollbackBatch(j1, URL);
    expect(res).toMatchObject({ deleted: 4, keptForReview: 0 });
    expect((await holders(c)).length).toBe(0);

    const j2 = await job();
    const again = await ingestStatementStream(db, KEYS, p, {
      companyId: c,
      jobId: j2,
      databaseUrl: URL,
      source,
    });
    expect(again.alreadyImported).toBe(false);
    expect((await holders(c)).every((h) => h.ingestion_job_id === j2)).toBe(true);
  });
});

describe("pan-india sources", () => {
  it("recognises registrars under their current and former names", () => {
    for (const n of [
      "KFin Technologies Limited",
      "Karvy Fintech Private Limited",
      "KFIN TECHNOLOGIES LTD.",
    ])
      expect(REGISTRAR_PATTERNS.KFINTECH.test(n)).toBe(true);
    for (const n of [
      "Link Intime India Private Limited",
      "MUFG Intime India Private Limited",
      "TSR Consultants Private Limited",
    ])
      expect(REGISTRAR_PATTERNS.LINK_INTIME.test(n)).toBe(true);
    expect(REGISTRAR_PATTERNS.KFINTECH.test("Bigshare Services")).toBe(false);
  });

  it("requires every drop-folder file to name its company and source URL", async () => {
    const m = await mkdtemp(join(tmpdir(), "finsol-manifest-"));
    await writeFile(
      join(m, "manifest.json"),
      JSON.stringify([{ file: "a.xlsx", company: "ACE", retrievedAt: "2026-11-02" }]),
    );
    await expect(readManifest(m)).rejects.toThrow(/sourceUrl/);
    await writeFile(
      join(m, "manifest.json"),
      JSON.stringify([
        {
          file: "../a.xlsx",
          company: "ACE",
          sourceUrl: "https://example.test/a.xlsx",
          retrievedAt: "2026-11-02",
        },
      ]),
    );
    await expect(readManifest(m)).rejects.toThrow(/plain file name/);
    await rm(m, { recursive: true, force: true });
  });
});
