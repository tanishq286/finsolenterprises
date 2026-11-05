/**
 * Re-reads published statements with the current reader and repairs the
 * holder records they produced. Dry run by default.
 *
 *   node dist/cli/reprocess-sources.js --manifest sources.json            dry run (report only)
 *   node dist/cli/reprocess-sources.js --manifest sources.json --apply    back up, then apply
 *   node dist/cli/reprocess-sources.js --rollback <backup table>          undo an apply
 *
 * sources.json: [{ "company": "<slug>", "url": "https://…", "file": "local/path.pdf" }]
 * (`file` is the downloaded copy; its SHA-256 is recorded with the URL.) Share
 * lists (IEPF-4) also need "shareBasis": "TRANSFERRED_TO_IEPF" or
 * "PROPOSED_IEPF_TRANSFER", as the acquisition worker records it.
 *
 * Rules:
 * - Reports aggregate counts only. Names, folio numbers and addresses are
 *   never printed.
 * - --apply against a non-local database also needs --confirm-production.
 * - Before applying, the affected columns of every record of the companies
 *   in the manifest are copied to a backup table (backup_folios_<time>).
 * - Nothing is deleted. Records the re-read no longer produces are not
 *   removed: they are quarantined (out of search) with NOT_REFOUND for a
 *   person to review.
 * - Re-running the same manifest is idempotent: source documents are keyed
 *   by checksum and reader version, rows by position, records by company,
 *   folio and holder name.
 */
import "dotenv/config";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

import pg from "pg";

import { createPrismaClient, ingestStatement, keysFromEnv, PARSER_VERSION } from "../index.js";
import type { StagedFolio } from "../bulk-copy.js";

interface ManifestEntry {
  company: string;
  url: string;
  file: string;
  /** ISO time the file was downloaded; defaults to the file's modification time. */
  retrievedAt?: string;
  /** ISO publication time if known (e.g. HTTP Last-Modified). */
  publishedAt?: string;
  publishedAtBasis?: "HTTP_LAST_MODIFIED" | "STATED_IN_DOCUMENT" | "UNKNOWN";
  /**
   * Share lists (IEPF-4) only: whether the listed shares were transferred to the
   * IEPF or are only due for transfer. Required for share lists; the dry run
   * stops before anything is backed up or written if one is missing.
   */
  shareBasis?: "PROPOSED_IEPF_TRANSFER" | "TRANSFERRED_TO_IEPF";
}

const BACKUP_COLUMNS = [
  "id",
  "state",
  "father_or_spouse_name",
  "father_or_spouse_raw",
  "address_line",
  "validation_status",
  "validation_issues",
  "review_status",
  "source_document_id",
  "source_row_ids",
  "quantity_basis",
  "quantity_effective_date",
  "amounts_by_event",
  "unclaimed_dividend_amount",
  "event_date",
  "transfer_financial_year",
  "investment_type",
  "updated_at",
];

function readOnlyUrl(url: string) {
  const u = new URL(url);
  u.searchParams.set("options", "-c default_transaction_read_only=on");
  return u.toString();
}

function isLocal(url: string) {
  return /@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      apply: { type: "boolean", default: false },
      "confirm-production": { type: "boolean", default: false },
      rollback: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL.");
  const production = !isLocal(url);
  if ((values.apply || values.rollback) && production && !values["confirm-production"])
    throw new Error(
      "This database is not local. Add --confirm-production only with approval for this change.",
    );

  if (values.rollback) return rollback(url, values.rollback);
  if (!values.manifest) throw new Error("Pass --manifest sources.json.");

  const manifest = JSON.parse(await readFile(values.manifest, "utf8")) as ManifestEntry[];
  // A dry run's session is read-only at the server, so it cannot write even by mistake.
  const sessionUrl = values.apply ? url : readOnlyUrl(url);
  const prisma = createPrismaClient(sessionUrl);
  const keys = keysFromEnv();
  const pool = new pg.Pool({ connectionString: sessionUrl, max: 2 });
  try {
    const slugs = [...new Set(manifest.map((m) => m.company))];
    const companies = await prisma.company.findMany({
      where: { slug: { in: slugs } },
      select: { id: true, slug: true },
    });
    const bySlug = new Map(companies.map((c) => [c.slug, c]));
    for (const s of slugs) if (!bySlug.has(s)) throw new Error(`Unknown company ${s}.`);
    const companyIds = companies.map((c) => c.id);

    // 1. Plan: what the current reader produces, without writing.
    const planned: StagedFolio[] = [];
    const perFile: Record<string, unknown>[] = [];
    for (const m of manifest) {
      const buffer = await readFile(m.file);
      const r = await ingestStatement(
        prisma,
        keys,
        { buffer, fileName: m.file.split("/").pop()!, contentType: "application/pdf" },
        {
          companyId: bySlug.get(m.company)!.id,
          dryRun: true,
          plan: true,
          ...(m.shareBasis ? { shareBasis: m.shareBasis } : {}),
        },
      );
      if (r.form === "IEPF_4" && !m.shareBasis)
        throw new Error(
          `${m.file.split("/").pop()} is a share list: set "shareBasis" (PROPOSED_IEPF_TRANSFER or TRANSFERRED_TO_IEPF) on its manifest entry. Nothing was written.`,
        );
      planned.push(...(r.planned ?? []));
      perFile.push({
        file: m.file.split("/").pop(),
        sha256: r.sha256.slice(0, 12),
        rows: r.totalRows,
        valid: r.validRows,
        warning: r.warningRows,
        quarantined: r.quarantinedRows,
        issues: r.issueCounts,
      });
    }
    // Lines of one holder across files merge into one record as the import
    // does: files apply in manifest order, so a later file's values win.
    const key = (f: { companyId: string; folioNumberHash: string; investorFullName: string }) =>
      `${f.companyId}|${f.folioNumberHash}|${f.investorFullName}`;
    const plan = new Map<string, StagedFolio>();
    for (const p of planned) {
      const k = key(p);
      const prev = plan.get(k);
      plan.set(k, {
        ...p,
        addressLine: p.addressLine ?? prev?.addressLine ?? null,
        validationStatus:
          prev?.validationStatus === "QUARANTINED" ? "QUARANTINED" : p.validationStatus,
      });
    }

    // 2. Compare with what is stored (read only).
    const { rows: existing } = await pool.query<{
      company_id: string;
      folio_number_hash: string;
      investor_full_name: string;
      father_or_spouse_name: string | null;
      address_line: string | null;
    }>(
      `SELECT company_id, folio_number_hash, investor_full_name, father_or_spouse_name,
              address_line
         FROM unclaimed_folios WHERE company_id = ANY($1::uuid[])`,
      [companyIds],
    );
    const stored = new Map(
      existing.map((e) => [
        key({
          companyId: e.company_id,
          folioNumberHash: e.folio_number_hash,
          investorFullName: e.investor_full_name,
        }),
        e,
      ]),
    );
    const diff = {
      storedRecords: existing.length,
      plannedRecords: plan.size,
      matched: 0,
      relativeChanged: 0,
      relativeCleared: 0,
      addressChanged: 0,
      wouldQuarantineMatched: 0,
      newRecords: 0,
      newRecordsQuarantined: 0,
      notRefound: 0,
    };
    for (const [k, p] of plan) {
      const e = stored.get(k);
      if (!e) {
        diff.newRecords++;
        if (p.validationStatus === "QUARANTINED") diff.newRecordsQuarantined++;
        continue;
      }
      diff.matched++;
      if ((e.father_or_spouse_name ?? null) !== (p.fatherOrSpouseName ?? null)) {
        diff.relativeChanged++;
        if (p.fatherOrSpouseName === null) diff.relativeCleared++;
      }
      if ((e.address_line ?? null) !== (p.addressLine ?? null)) diff.addressChanged++;
      if (p.validationStatus === "QUARANTINED") diff.wouldQuarantineMatched++;
    }
    for (const k of stored.keys()) if (!plan.has(k)) diff.notRefound++;

    const report = {
      mode: values.apply ? "apply" : "dry-run",
      database: production ? "non-local" : "local",
      parserVersion: PARSER_VERSION,
      files: perFile,
      diff,
    };
    console.log(values.json ? JSON.stringify(report, null, 2) : report);
    if (!values.apply) {
      console.log("\nDry run: nothing was written. Re-run with --apply to back up and apply.");
      return;
    }

    // 3. Back up the affected columns, then apply through the normal importer.
    const backup = `backup_folios_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
    await pool.query(
      `CREATE TABLE ${backup} AS SELECT ${BACKUP_COLUMNS.join(", ")}, now() AS backed_up_at
         FROM unclaimed_folios WHERE company_id = ANY($1::uuid[])`,
      [companyIds],
    );
    const { rows: counted } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${backup}`,
    );
    console.log(`Backed up ${counted[0]!.n} records to ${backup}.`);

    const docIds: string[] = [];
    for (const m of manifest) {
      const buffer = await readFile(m.file);
      const r = await ingestStatement(
        prisma,
        keys,
        { buffer, fileName: m.file.split("/").pop()!, contentType: "application/pdf" },
        {
          companyId: bySlug.get(m.company)!.id,
          databaseUrl: url,
          ...(m.shareBasis ? { shareBasis: m.shareBasis } : {}),
          source: {
            url: m.url,
            retrievedAt: new Date(m.retrievedAt ?? (await stat(m.file)).mtime),
            publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
            publishedAtBasis:
              m.publishedAtBasis ?? (m.publishedAt ? "HTTP_LAST_MODIFIED" : "UNKNOWN"),
          },
        },
      );
      if (r.sourceDocumentId) docIds.push(r.sourceDocumentId);
      console.log(
        `${m.file.split("/").pop()}: ${r.insertedRows} new, ${r.updatedRows} updated, ${r.quarantinedRows} rows quarantined.`,
      );
    }
    // Records the re-read did not produce again: out of search, flagged for review, kept.
    const { rowCount } = await pool.query(
      `UPDATE unclaimed_folios
          SET review_status = 'QUARANTINED', validation_status = 'QUARANTINED',
              validation_issues = array_append(array_remove(validation_issues, 'NOT_REFOUND'), 'NOT_REFOUND'),
              updated_at = now()
        WHERE company_id = ANY($1::uuid[])
          AND (source_document_id IS NULL OR NOT (source_document_id = ANY($2::uuid[])))
          AND review_status = 'PUBLISHED'`,
      [companyIds, docIds],
    );
    console.log(`${rowCount} records not produced again were quarantined for review.`);
    console.log(`Rollback: node dist/cli/reprocess-sources.js --rollback ${backup}`);
  } finally {
    await pool.end();
    await prisma.$disconnect();
  }
}

/**
 * Restores the backed-up columns. Records the apply created (absent from the
 * backup) are withdrawn from search, not deleted, so their provenance stays.
 */
async function rollback(url: string, backup: string) {
  if (!/^backup_folios_\d{14}$/.test(backup)) throw new Error("Not a backup table name.");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const set = BACKUP_COLUMNS.filter((col) => col !== "id" && col !== "state")
      .map((col) => `${col} = b.${col}`)
      .join(", ");
    const restored = await c.query(
      `UPDATE unclaimed_folios f SET ${set} FROM ${backup} b WHERE f.id = b.id AND f.state = b.state`,
    );
    const withdrawn = await c.query(
      `UPDATE unclaimed_folios f SET review_status = 'WITHDRAWN', updated_at = now()
        WHERE f.company_id IN (SELECT DISTINCT company_id FROM unclaimed_folios u JOIN ${backup} b ON u.id = b.id)
          AND NOT EXISTS (SELECT 1 FROM ${backup} b WHERE b.id = f.id)
          AND f.created_at > (SELECT min(backed_up_at) FROM ${backup})`,
    );
    await c.query("COMMIT");
    console.log(
      `Restored ${restored.rowCount} records; withdrew ${withdrawn.rowCount} added by the apply.`,
    );
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
