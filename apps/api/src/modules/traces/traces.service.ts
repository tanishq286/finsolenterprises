import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { decryptField, encryptField } from "@finsol/db";
import { PrismaService } from "../../common/prisma.service.js";
import { AuditService } from "../../common/audit.service.js";
import type { SessionClaims } from "../../common/auth/tokens.service.js";
import { SearchService } from "../search/search.service.js";
import type { CheckInput, TraceInput } from "./traces.controller.js";

const summary = {
  id: true,
  reference: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class TracesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly audit: AuditService,
  ) {}
  async create(body: TraceInput, user: SessionClaims) {
    const reference = `FIN-TRC-${createHash("sha256").update(`${user.sub}:${body.requestId}`).digest("hex").slice(0, 6).toUpperCase()}`;
    const prior = await this.prisma.client.traceRequest.findUnique({
      where: { reference },
      select: summary,
    });
    if (prior) return prior;
    const account = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: user.sub },
      select: { phone: true, email: true },
    });
    const { requestId: _requestId, consent: _consent, claimantName, claimantEmail, claimantMobile, ...details } = body;
    const contactInfo = {
      phone: claimantMobile || account.phone,
      email: claimantEmail || account.email,
      name: claimantName || null,
    };
    const coverage = await this.search.coverage();
    return this.prisma.client.traceRequest.upsert({
      where: { reference },
      update: {},
      select: summary,
      create: {
        reference,
        userId: user.sub,
        holderName: encryptField(body.holderName, this.prisma.fieldKeys),
        scope: body.scope,
        status: "PENDING_AUDIT",
        detailsEnc: encryptField(
          JSON.stringify({ ...details, contact: contactInfo, consentVersion: "assisted-trace-v1" }),
          this.prisma.fieldKeys,
        ),
        consentAt: new Date(),
        indexSnapshot: JSON.parse(
          JSON.stringify({
            recordedAt: new Date().toISOString(),
            coverage,
            meaning: "Index coverage at request time; not proof that all sources were searched.",
          }),
        ),
      },
    });
  }
  async mine(user: SessionClaims) {
    return this.prisma.client.traceRequest.findMany({
      where: { userId: user.sub },
      select: summary,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  async withdraw(id: string, user: SessionClaims) {
    const changed = await this.prisma.client.traceRequest.updateMany({
      where: { id, userId: user.sub },
      data: { status: "WITHDRAWN", updatedAt: new Date() },
    });
    if (!changed.count) throw new NotFoundException("Trace request not found.");
    return { status: "WITHDRAWN" };
  }
  async list(page: number) {
    const [items, total] = await Promise.all([
      this.prisma.client.traceRequest.findMany({
        select: { ...summary, scope: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * 50,
        take: 50,
      }),
      this.prisma.client.traceRequest.count(),
    ]);
    return { items, total, page };
  }
  async get(id: string, user: SessionClaims) {
    const item = await this.prisma.client.traceRequest.findUnique({
      where: { id },
      include: { checks: { orderBy: { checkedAt: "desc" } } },
    });
    if (!item) throw new NotFoundException("Trace request not found.");
    await this.audit.record({
      actorId: user.sub,
      actorRole: user.role,
      action: "TRACE_VIEWED",
      entityType: "TraceRequest",
      entityId: id,
    });
    const { detailsEnc, holderName, ...rest } = item;
    return {
      ...rest,
      holderName: decryptField(holderName, this.prisma.fieldKeys),
      details: JSON.parse(decryptField(detailsEnc, this.prisma.fieldKeys)),
      checks: item.checks.map((c) => ({
        ...c,
        note: c.note ? decryptField(c.note, this.prisma.fieldKeys) : null,
      })),
    };
  }
  async check(id: string, body: CheckInput, user: SessionClaims) {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM trace_requests WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException("Trace request not found.");
      if (rows[0].status === "WITHDRAWN" || rows[0].status.startsWith("CLOSED"))
        throw new BadRequestException("This request is closed or withdrawn.");
      const result = await tx.traceCheck.create({
        data: {
          traceId: id,
          ...body,
          note: body.note ? encryptField(body.note, this.prisma.fieldKeys) : null,
          checkedById: user.sub,
        },
        select: { id: true, outcome: true, checkedAt: true },
      });
      await tx.traceRequest.update({
        where: { id },
        data: { status: "IN_PROGRESS", updatedAt: new Date() },
      });
      return result;
    });
  }
  async update(id: string, status: string, user: SessionClaims) {
    return this.prisma.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status FROM trace_requests WHERE id = ${id}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException("Trace request not found.");
      if (rows[0].status === "WITHDRAWN")
        throw new BadRequestException(
          "Consent was withdrawn; create a new request with fresh consent.",
        );
      if (status.startsWith("CLOSED") || status === "MATCH_FOUND") {
        const count = await tx.traceCheck.count({
          where: { traceId: id, ...(status === "CLOSED_FOUND" || status === "MATCH_FOUND" ? { outcome: "MATCH_FOUND" } : {}) },
        });
        if (!count && status !== "CLOSED")
          throw new BadRequestException("Record the source check before closing this request.");
      }
      const result = await tx.traceRequest.update({
        where: { id },
        data: { status, updatedAt: new Date() },
        select: summary,
      });
      await tx.auditEvent.create({
        data: {
          actorId: user.sub,
          actorRole: user.role,
          action: "TRACE_STATUS_CHANGED",
          entityType: "TraceRequest",
          entityId: id,
          data: { status },
        },
      });
      return result;
    });
  }
}
