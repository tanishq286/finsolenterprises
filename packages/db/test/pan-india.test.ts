import { describe, expect, it } from "vitest";
import {
  HeaderMapper,
  maskFolio,
  normalizeFolioRow,
  parseDateFlexible,
} from "../src/pan-india/normalizer.js";
import { streamRowsInChunks } from "../src/pan-india/streaming-chunker.js";
import { KFintechAdapter } from "../src/pan-india/adapters/kfintech.js";
import { LinkIntimeAdapter } from "../src/pan-india/adapters/link-intime.js";
import { BlueChipsAdapter } from "../src/pan-india/adapters/blue-chips.js";
import { decryptField } from "../src/crypto.js";

const TEST_KEYS = {
  encryptionKey: Buffer.alloc(32, 1),
  hashKey: Buffer.alloc(32, 2),
};

describe("Pan-India IEPF-2 Ingestion: Normalizer & Header Mapping", () => {
  it("maps diverse RTA header conventions correctly", () => {
    const kfinHeaders = [
      "Investor First Name",
      "Investor Middle Name",
      "Investor Last Name",
      "Father / Husband First Name",
      "Folio Number / DP ID Client ID",
      "Amount Transferred",
      "Proposed Date of Transfer to IEPF",
      "State",
      "Pin Code",
      "Number of Shares",
    ];
    const kfinMapper = new HeaderMapper(kfinHeaders);
    expect(kfinMapper.has("firstName")).toBe(true);
    expect(kfinMapper.has("folio")).toBe(true);
    expect(kfinMapper.has("amount")).toBe(true);
    expect(kfinMapper.has("eventDate")).toBe(true);
    expect(kfinMapper.has("state")).toBe(true);
    expect(kfinMapper.has("shares")).toBe(true);

    const linkIntimeHeaders = [
      "FOLIO NO",
      "SHAREHOLDER NAME",
      "FATHER / HUSBAND NAME",
      "ADDRESS LINE 1",
      "DISTRICT",
      "STATE",
      "PINCODE",
      "UNCLAIMED AMOUNT",
      "DUE DATE OF TRANSFER",
      "NUMBER OF SHARES",
    ];
    const linkMapper = new HeaderMapper(linkIntimeHeaders);
    expect(linkMapper.has("folio")).toBe(true);
    expect(linkMapper.has("firstName") || linkMapper.has("fullName")).toBe(true);
    expect(linkMapper.has("amount")).toBe(true);
    expect(linkMapper.has("state")).toBe(true);
    expect(linkMapper.has("eventDate")).toBe(true);
  });

  it("normalizes, encrypts, and indexes a raw KFintech IEPF-2 row", () => {
    const raw = {
      "Investor First Name": "Suresh",
      "Investor Middle Name": "Kumar",
      "Investor Last Name": "Patel",
      "Father / Husband First Name": "Late Ramesh Patel",
      "Folio Number / DP ID Client ID": "INFY00123456",
      "Amount Transferred": "1,450.75",
      "Proposed Date of Transfer to IEPF": "2024-11-15",
      "State": "Gujarat",
      "City": "Ahmedabad",
      "Pin Code": "380001",
      "Number of Shares": "50",
    };

    const mapper = new HeaderMapper(Object.keys(raw));
    const normalized = normalizeFolioRow(raw, mapper, {
      companyId: "00000000-0000-0000-0000-000000000001",
      companyName: "Infosys Limited",
      sourceRta: "KFINTECH",
      sourceFileName: "infosys_iepf2.xlsx",
      batchRunId: "00000000-0000-0000-0000-000000000002",
      keys: TEST_KEYS,
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.investorFullName).toBe("SURESH KUMAR PATEL");
    expect(normalized!.state).toBe("GUJARAT");
    expect(normalized!.pincode).toBe("380001");
    expect(normalized!.originalShares).toBe(50);
    expect(normalized!.rawAmount).toBe(1450.75);
    expect(normalized!.folioNumberMasked).toBe("INF***56");
    expect(normalized!.folioNumberHash).toHaveLength(64);

    // Verify folio encryption is reversible with the key
    const decryptedFolio = decryptField(normalized!.folioNumber, TEST_KEYS);
    expect(decryptedFolio).toBe("INFY00123456");
  });

  it("correctly derives state from PIN code when state column is omitted", () => {
    const raw = {
      "Investor Name": "Vandana Kulkarni",
      "Folio No": "TATA12345",
      "Amount": "250.00",
      "Pincode": "400001",
    };
    const mapper = new HeaderMapper(Object.keys(raw));
    const normalized = normalizeFolioRow(raw, mapper, {
      companyId: "00000000-0000-0000-0000-000000000001",
      companyName: "Tata Motors Limited",
      sourceRta: "LINK_INTIME",
      sourceFileName: "tatamotors_iepf2.xlsx",
      batchRunId: "00000000-0000-0000-0000-000000000002",
      keys: TEST_KEYS,
    });

    expect(normalized).not.toBeNull();
    expect(normalized!.state).toBe("MAHARASHTRA");
    expect(normalized!.validationIssues).toContain("STATE_FROM_PIN");
  });
});

describe("Pan-India Streaming Chunker: Memory Safety", () => {
  it("streams rows in exact chunks and reports flat memory usage", async () => {
    function* generateRows(count: number) {
      for (let i = 0; i < count; i++) {
        yield { id: i, name: `Investor ${i}`, amount: `${i * 10}.00` };
      }
    }

    const chunkSizes: number[] = [];
    const memoryReports: number[] = [];
    let totalProcessed = 0;

    for await (const chunk of streamRowsInChunks(generateRows(1250), ["id", "name", "amount"], 500)) {
      chunkSizes.push(chunk.rows.length);
      memoryReports.push(chunk.memoryMb);
      totalProcessed += chunk.rows.length;
    }

    expect(chunkSizes).toEqual([500, 500, 250]);
    expect(totalProcessed).toBe(1250);
    expect(memoryReports.every((m) => m > 0 && m < 500)).toBe(true);
  });
});

describe("Pan-India RTA Adapters: Discovery & Synthesis", () => {
  it("discovers KFintech blue-chip companies and produces valid IEPF-2 rows", async () => {
    const kfin = new KFintechAdapter();
    const companies = await kfin.discover({ limit: 5 });
    expect(companies.length).toBe(5);
    expect(companies[0]!.rta).toBe("KFINTECH");

    const samples = kfin.getSampleFiles();
    expect(samples.length).toBeGreaterThan(0);
    const rows = samples[0]!.generateRows!(10);
    expect(rows.length).toBe(10);
    expect(rows[0]!).toHaveProperty("Folio Number / DP ID Client ID");
    expect(rows[0]!).toHaveProperty("Amount Transferred");
  });

  it("discovers Link Intime companies and produces Link Intime schema rows", async () => {
    const link = new LinkIntimeAdapter();
    const companies = await link.discover({ companyQuery: "tata" });
    expect(companies.length).toBeGreaterThanOrEqual(3);
    expect(companies.every((c) => c.rta === "LINK_INTIME")).toBe(true);

    const rows = link.generateSampleRows(companies[0]!, 10);
    expect(rows.length).toBe(10);
    expect(rows[0]!).toHaveProperty("FOLIO NO");
    expect(rows[0]!).toHaveProperty("SHAREHOLDER NAME");
  });

  it("discovers BSE 500 / NSE Blue Chips registry companies", async () => {
    const blueChips = new BlueChipsAdapter();
    const companies = await blueChips.discover();
    expect(companies.some((c) => c.nseSymbol === "RELIANCE")).toBe(true);
    expect(companies.some((c) => c.nseSymbol === "ITC")).toBe(true);
    expect(companies.some((c) => c.nseSymbol === "LT")).toBe(true);

    const rows = blueChips.generateSampleRows(companies[0]!, 5);
    expect(rows.length).toBe(5);
    expect(rows[0]!).toHaveProperty("Folio Number");
  });
});
