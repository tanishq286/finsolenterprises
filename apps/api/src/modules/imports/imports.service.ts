import { randomUUID } from "node:crypto";

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { decryptField, formatOf, ingestStatement, mapHeaders, readStatement } from "@finsol/db";
import type { IngestionForm } from "@finsol/shared";

import { AuditService } from "../../common/audit.service.js";
import { PrismaService } from "../../common/prisma.service.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { DOCUMENT_STORAGE, type DocumentStorage } from "../../common/providers/storage.provider.js";
import { JobQueueService } from "../../common/queue/job-queue.service.js";
import { isoTime } from "../../common/serialize.js";

const MAX_FILE_MB = 40;

/**
 * Admin importer for real IEPF-2 / IEPF-4 statements (.xlsx, .xls, .csv,
 * .pdf). Parsing is the same code the `ingest:iepf` CLI runs
 * (packages/db/src/ingest-iepf.ts); this service stores the file, queues the
 * job and records its outcome.
 */
@Injectable()
export class ImportsService {
  private readonly log = new Logger("Imports");

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobQueueService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  async upload(
    user: SessionClaims,
    form: IngestionForm | undefined,
    file: { originalname: string; buffer: Buffer; size: number; mimetype?: string } | undefined,
    companySlug?: string,
    sourceUrl?: string,
  ) {
    if (!file) throw new BadRequestException("Attach the statement: .xlsx, .xls, .csv or .pdf.");
    if (!formatOf(file.originalname, file.mimetype))
      throw new BadRequestException("Upload a .xlsx, .xls, .csv or .pdf statement.");
    if (file.size > MAX_FILE_MB * 1024 * 1024)
      throw new BadRequestException(`Files can be up to ${MAX_FILE_MB} MB.`);
    let companyId: string | null = null;
    if (companySlug) {
      const c = await this.prisma.client.company.findUnique({ where: { slug: companySlug } });
      if (!c) throw new BadRequestException("Unknown company.");
      companyId = c.id;
    }
    // Read the header now, so a wrong file fails at upload rather than in the queue.
    try {
      const table = await readStatement(file.buffer, file.originalname, file.mimetype);
      const { map } = mapHeaders(table.headers);
      if (map.first === undefined && map.fullName === undefined && map.last === undefined)
        throw new Error("No investor name column was found.");
      if (!companyId && map.cin === undefined && map.companyName === undefined)
        throw new Error("Choose the company, or include a CIN or company name column.");
      if (map.shares !== undefined && !form)
        throw new Error(
          "Share lists need an explicit IEPF_4 classification confirming completed transfer. Proposed or ambiguous lists require acquisition review.",
        );
      form ??= "IEPF_2";
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const safeName = file.originalname.replace(/[^\w.-]+/g, "_");
    const storageKey = await this.storage.put(
      `imports/${randomUUID()}-${safeName}`,
      file.buffer,
      file.mimetype ?? "application/octet-stream",
    );
    const job = await this.prisma.client.ingestionJob.create({
      data: {
        formType: form,
        fileName: file.originalname,
        storageKey,
        sourceUrl: sourceUrl || null,
        companyId,
        uploadedById: user.sub,
      },
    });
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: "imports.upload",
      entityType: "ingestion_job",
      entityId: job.id,
      data: { form, fileName: file.originalname, sourceUrl },
    });
    await this.jobs.enqueue("ingestion.process", { jobId: job.id });
    return this.view(job.id);
  }

  async list() {
    const jobs = await this.prisma.client.ingestionJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { uploadedBy: { select: { name: true } } },
    });
    return jobs.map((j) => this.shape(j));
  }

  async view(id: string) {
    const job = await this.prisma.client.ingestionJob.findUnique({
      where: { id },
      include: { uploadedBy: { select: { name: true } } },
    });
    if (!job) throw new NotFoundException("No such import.");
    return this.shape(job);
  }

  private shape(
    j: Awaited<ReturnType<typeof this.prisma.client.ingestionJob.findUniqueOrThrow>> & {
      uploadedBy?: { name: string } | null;
    },
  ) {
    return {
      id: j.id,
      formType: j.formType,
      fileName: j.fileName,
      sourceUrl: j.sourceUrl,
      status: j.status,
      totalRows: j.totalRows,
      insertedRows: j.insertedRows,
      updatedRows: j.updatedRows,
      skippedRows: j.skippedRows,
      warningRows: j.warningRows,
      quarantinedRows: j.quarantinedRows,
      parserVersion: j.parserVersion,
      sourceDocumentId: j.sourceDocumentId,
      retryOfId: j.retryOfId,
      errors: (j.errors as { row: number; message: string }[] | null) ?? [],
      uploadedBy:
        j.uploadedBy?.name ??
        (j.storageKey.startsWith("cli:") || j.storageKey.startsWith("file:")
          ? "Command line"
          : null),
      createdAt: isoTime(j.createdAt),
      startedAt: isoTime(j.startedAt),
      finishedAt: isoTime(j.finishedAt),
    };
  }

  /** Runs a failed or finished import again from its stored file, as a new job. */
  async retry(user: SessionClaims, id: string) {
    const old = await this.prisma.client.ingestionJob.findUnique({ where: { id } });
    if (!old) throw new NotFoundException("No such import.");
    if (old.status === "PROCESSING" || old.status === "QUEUED")
      throw new BadRequestException("This import is still running.");
    if (old.storageKey.startsWith("cli:") || old.storageKey.startsWith("file:"))
      throw new BadRequestException("This import came from the command line; run it there again.");
    const job = await this.prisma.client.ingestionJob.create({
      data: {
        formType: old.formType,
        fileName: old.fileName,
        storageKey: old.storageKey,
        sourceUrl: old.sourceUrl,
        companyId: old.companyId,
        uploadedById: user.sub,
        retryOfId: old.id,
      },
    });
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: "imports.retry",
      entityType: "ingestion_job",
      entityId: job.id,
      data: { retryOf: old.id },
    });
    await this.jobs.enqueue("ingestion.process", { jobId: job.id });
    return this.view(job.id);
  }

  /**
   * Aggregate coverage for the admin dashboard: counts only, never names or
   * folio numbers. Listed equities, company profiles, prices and holder
   * records are reported separately, because they measure different things.
   */
  async coverage() {
    const db = this.prisma.client;
    const [
      listedEquities,
      companies,
      byCompany,
      byStatus,
      sources,
      jobs,
      prices,
      actions,
      quarantine,
      groups,
    ] = await Promise.all([
      db.listedEquity.count(),
      db.company.findMany({
        select: { id: true, name: true, slug: true, irPageUrl: true, contactsVerifiedAt: true },
        orderBy: { name: "asc" },
      }),
      db.$queryRaw<
        {
          company_id: string;
          custody_status: string;
          records: bigint;
          folios: bigint;
          groups: bigint;
        }[]
      >`SELECT company_id, custody_status::text, count(*) AS records,
               count(DISTINCT folio_number_hash) AS folios,
               count(DISTINCT investor_cluster_id) AS groups
          FROM unclaimed_folios GROUP BY 1, 2`,
      db.$queryRaw<{ validation_status: string; review_status: string; records: bigint }[]>`
        SELECT validation_status, review_status, count(*) AS records
          FROM unclaimed_folios GROUP BY 1, 2 ORDER BY 1, 2`,
      db.sourceDocument.findMany({
        orderBy: { retrievedAt: "desc" },
        take: 100,
        select: {
          id: true,
          companyId: true,
          fileName: true,
          sourceUrl: true,
          documentType: true,
          reportingPeriod: true,
          publishedAt: true,
          publishedAtBasis: true,
          retrievedAt: true,
          sha256: true,
          parserVersion: true,
          status: true,
          reviewStatus: true,
          publicationStatus: true,
          quantityBasis: true,
          rowCount: true,
          validRows: true,
          warningRows: true,
          quarantinedRows: true,
        },
      }),
      db.ingestionJob.groupBy({
        by: ["status"],
        _count: { _all: true },
        _max: { finishedAt: true },
      }),
      db.company.findMany({
        select: {
          slug: true,
          currentMarketPrice: true,
          priceQuoteAt: true,
          priceUpdatedAt: true,
          priceAttemptedAt: true,
          priceError: true,
          priceSource: true,
        },
      }),
      db.corporateAction.groupBy({ by: ["companyId"], _count: { _all: true } }),
      db.sourceRow.groupBy({
        by: ["validationStatus", "reviewStatus"],
        _count: { _all: true },
      }),
      db.$queryRaw<
        { n: bigint }[]
      >`SELECT count(DISTINCT investor_cluster_id) AS n FROM unclaimed_folios`,
    ]);
    const n = (v: bigint | number) => Number(v);
    const holders = new Map<
      string,
      { records: number; folios: number; groups: number; byCustody: Record<string, number> }
    >();
    for (const r of byCompany) {
      const h = holders.get(r.company_id) ?? { records: 0, folios: 0, groups: 0, byCustody: {} };
      h.records += n(r.records);
      h.folios += n(r.folios);
      h.groups += n(r.groups);
      h.byCustody[r.custody_status] = n(r.records);
      holders.set(r.company_id, h);
    }
    const actionCount = new Map(actions.map((a) => [a.companyId, a._count._all]));
    const priceBy = new Map(prices.map((p) => [p.slug, p]));
    return {
      asOf: new Date().toISOString(),
      listedEquities,
      companyProfiles: companies.length,
      holderRecords: [...holders.values()].reduce((a, h) => a + h.records, 0),
      recordGroups: n(groups[0]?.n ?? 0),
      byValidation: byStatus.map((b) => ({ ...b, records: n(b.records) })),
      companies: companies.map((c) => {
        const h = holders.get(c.id);
        const p = priceBy.get(c.slug);
        return {
          name: c.name,
          slug: c.slug,
          holderRecords: h?.records ?? 0,
          distinctFolios: h?.folios ?? 0,
          recordGroups: h?.groups ?? 0,
          byCustody: h?.byCustody ?? {},
          corporateActions: actionCount.get(c.id) ?? 0,
          hasIrPage: !!c.irPageUrl,
          price: p?.currentMarketPrice === null || !p ? null : Number(p.currentMarketPrice),
          priceSource: p?.priceSource ?? null,
          priceQuoteAt: isoTime(p?.priceQuoteAt ?? null),
          priceRetrievedAt: isoTime(p?.priceUpdatedAt ?? null),
          priceAttemptedAt: isoTime(p?.priceAttemptedAt ?? null),
          priceError: p?.priceError ?? null,
        };
      }),
      sources: sources.map((d) => ({
        ...d,
        sha256: d.sha256.slice(0, 12),
        publishedAt: isoTime(d.publishedAt),
        retrievedAt: isoTime(d.retrievedAt),
      })),
      jobs: jobs.map((j) => ({
        status: j.status,
        count: j._count._all,
        latestFinishedAt: isoTime(j._max.finishedAt),
      })),
      sourceRows: quarantine.map((q) => ({
        validationStatus: q.validationStatus,
        reviewStatus: q.reviewStatus,
        rows: q._count._all,
      })),
    };
  }

  /** Quarantined rows for review. Raw cells are decrypted for staff and the read is audited. */
  async quarantine(user: SessionClaims, documentId?: string) {
    const rows = await this.prisma.client.sourceRow.findMany({
      where: {
        validationStatus: "QUARANTINED",
        reviewStatus: "PENDING_REVIEW",
        ...(documentId ? { sourceDocumentId: documentId } : {}),
      },
      orderBy: [{ sourceDocumentId: "asc" }, { rowIndex: "asc" }],
      take: 50,
      include: { document: { select: { fileName: true, sourceUrl: true } } },
    });
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: "imports.quarantine.read",
      entityType: "source_document",
      entityId: documentId ?? null,
      data: { rows: rows.map((r) => r.id) },
    });
    return rows.map((r) => ({
      id: r.id,
      document: r.document.fileName,
      sourceUrl: r.document.sourceUrl,
      rowRef: r.rowRef,
      issues: r.issues,
      extractionNotes: r.extractionNotes,
      rawCells: JSON.parse(decryptField(r.rawCellsEnc, this.prisma.fieldKeys)) as Record<
        string,
        unknown
      >,
      hasRecord: !!r.folioId,
    }));
  }

  /**
   * A reviewer's decision on a quarantined row. APPROVED publishes the holder
   * record it fed (searchable again); REJECTED withdraws it. Nothing is deleted.
   */
  async reviewRow(
    user: SessionClaims,
    rowId: string,
    decision: "APPROVED" | "REJECTED",
    note: string,
  ) {
    const db = this.prisma.client;
    const row = await db.sourceRow.findUnique({ where: { id: rowId } });
    if (!row || row.validationStatus !== "QUARANTINED")
      throw new NotFoundException("No quarantined row with that id.");
    await db.$transaction(async (tx) => {
      await tx.sourceRow.update({
        where: { id: rowId },
        data: { reviewStatus: decision, reviewedById: user.sub, reviewedAt: new Date() },
      });
      if (row.folioId && row.folioState) {
        // A holder record is published only when none of its rows still waits for review.
        const pending = await tx.sourceRow.count({
          where: {
            folioId: row.folioId,
            validationStatus: "QUARANTINED",
            reviewStatus: "PENDING_REVIEW",
          },
        });
        const status = decision === "REJECTED" ? "WITHDRAWN" : pending ? null : "PUBLISHED";
        if (status)
          await tx.$executeRaw`
            UPDATE unclaimed_folios SET review_status = ${status}, updated_at = now()
            WHERE id = ${row.folioId}::uuid AND state = ${row.folioState}::"IndianState"`;
      }
    });
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: "imports.quarantine.review",
      entityType: "source_row",
      entityId: rowId,
      data: { decision, note },
    });
    return { id: rowId, decision };
  }

  /** The job body. Runs in the worker (BullMQ) or inline. Safe to re-run: rows upsert. */
  async process(jobId: string): Promise<void> {
    const db = this.prisma.client;
    const job = await db.ingestionJob.update({
      where: { id: jobId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
    try {
      const buffer = await this.storage.get(job.storageKey);
      const r = await ingestStatement(
        db,
        this.prisma.fieldKeys,
        { buffer, fileName: job.fileName },
        {
          companyId: job.companyId,
          form: job.formType,
          // Explicit staff classification, recorded in the upload audit trail.
          ...(job.formType === "IEPF_4" ? { shareBasis: "TRANSFERRED_TO_IEPF" as const } : {}),
          jobId: job.id,
          databaseUrl: this.prisma.databaseUrl,
          source: {
            url: job.sourceUrl,
            retrievedAt: job.createdAt,
            // A staff upload with no public URL is an authorised upload.
            documentType: job.sourceUrl
              ? job.formType === "IEPF_4"
                ? "IEPF_4_STATEMENT"
                : "IEPF_2_STATEMENT"
              : "AUTHORISED_UPLOAD",
          },
        },
      );
      await db.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          totalRows: r.totalRows,
          insertedRows: r.insertedRows,
          updatedRows: r.updatedRows,
          skippedRows: r.skippedRows,
          warningRows: r.warningRows,
          quarantinedRows: r.quarantinedRows,
          parserVersion: r.parserVersion,
          sourceDocumentId: r.sourceDocumentId,
          errors: r.errors,
          finishedAt: new Date(),
        },
      });
      if (r.insertedRows + r.updatedRows)
        await this.jobs.enqueue("search.sync", { ingestionJobId: job.id });
      this.log.log(
        `${job.fileName}: ${r.insertedRows} new, ${r.updatedRows} updated, ${r.skippedRows} skipped of ${r.totalRows}.`,
      );
    } catch (e) {
      await db.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          errors: [{ row: 0, message: (e as Error).message }],
          finishedAt: new Date(),
        },
      });
      throw e;
    }
  }
}
