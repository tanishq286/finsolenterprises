"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRightIcon,
  BadgeCheckIcon,
  GripVerticalIcon,
  LoaderCircleIcon,
  PhoneIcon,
  UserRoundIcon,
} from "lucide-react";
import { SCENARIO_LABELS, SCENARIO_TYPES, TRACK_LABELS, type ScenarioType } from "@finsol/shared";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { callApi, ClientApiError } from "@/lib/api/client";
import { formatDate, formatDateTime, formatPaiseCompact } from "@/lib/format";
import type { Board, BoardColumn, CaseCard, LeadCard, TeamMember } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type Card = LeadCard | CaseCard;

/**
 * The CRM board: five lead stages, then three case columns (mandate and
 * eSign, IEPF-5 and nodal verification, demat credit). Cards move by drag
 * and drop, or by the "Move to" menu on each card, which is also the
 * keyboard and touch path. The server decides what is allowed.
 */
export function KanbanBoard({ board, team }: { board: Board; team: TeamMember[] }) {
  const router = useRouter();
  const [columns, setColumns] = React.useState(board.columns);
  const [dragging, setDragging] = React.useState<{ card: Card; from: string } | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [converting, setConverting] = React.useState<LeadCard | null>(null);

  // A fresh board from the server replaces the optimistic one.
  const [shown, setShown] = React.useState(board);
  if (shown !== board) {
    setShown(board);
    setColumns(board.columns);
  }

  const kindOf = (id: string) => columns.find((c) => c.id === id)?.kind;

  function moveLocally(card: Card, from: string, to: string) {
    setColumns((cols) =>
      cols.map((c) =>
        c.id === from
          ? { ...c, items: c.items.filter((i) => i.id !== card.id) }
          : c.id === to
            ? { ...c, items: [card, ...c.items] }
            : c,
      ),
    );
  }

  async function move(card: Card, from: string, to: string) {
    if (from === to) return;
    setError(null);
    if (card.type === "lead" && kindOf(to) === "case") {
      setConverting(card);
      return;
    }
    if (card.type === "case" && kindOf(to) === "lead") {
      setError("A case cannot go back to the lead stages.");
      return;
    }
    const before = columns;
    moveLocally(card, from, to);
    setBusyId(card.id);
    try {
      if (card.type === "lead")
        await callApi(`crm/leads/${card.id}`, { method: "PATCH", body: { crmStage: to } });
      else await callApi("crm/cases/move", { body: { caseCode: card.caseCode, column: to } });
      router.refresh();
    } catch (e) {
      setColumns(before);
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function assign(card: LeadCard, analystId: string) {
    setBusyId(card.id);
    setError(null);
    try {
      await callApi(`crm/leads/${card.id}`, {
        method: "PATCH",
        body: { assignedAnalystId: analystId || null },
      });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {error && (
        <Alert variant="blocker" role="alert" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div
        className="-mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6"
        role="region"
        aria-label="CRM board"
        tabIndex={0}
      >
        <div className="flex min-w-max gap-4">
          {columns.map((col, ci) => (
            <section
              key={col.id}
              aria-labelledby={`col-${col.id}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setOver(col.id);
              }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging) move(dragging.card, dragging.from, col.id);
                setDragging(null);
              }}
              className={cn(
                "relative flex w-[19rem] shrink-0 flex-col rounded-[16px] border border-(--glass-border) bg-ink-900/60 p-3 transition-[border-color,background-color] duration-150",
                col.kind === "case" && "bg-iepf-wash/30",
                over === col.id && "border-signal bg-signal-wash/40",
                ci === 5 && "ml-3",
              )}
            >
              <h2
                id={`col-${col.id}`}
                className="flex items-center justify-between gap-2 px-1 pb-3 text-sm font-semibold text-fg"
              >
                <span>{col.label}</span>
                <span className="rounded-full bg-(--glass-elevated) px-2 py-0.5 text-xs text-fg-2 tnum">
                  {col.items.length}
                </span>
              </h2>
              <ul className="grid gap-2">
                {col.items.map((card) => (
                  <li
                    key={card.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      setDragging({ card, from: col.id });
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={cn(
                      "panel relative cursor-grab p-3 active:cursor-grabbing",
                      busyId === card.id && "opacity-60",
                      dragging?.card.id === card.id && "opacity-40",
                    )}
                  >
                    {card.type === "lead" ? (
                      <LeadCardView
                        card={card}
                        team={team}
                        columns={columns}
                        from={col.id}
                        onMove={move}
                        onAssign={assign}
                        busy={busyId === card.id}
                      />
                    ) : (
                      <CaseCardView
                        card={card}
                        columns={columns}
                        from={col.id}
                        onMove={move}
                        busy={busyId === card.id}
                      />
                    )}
                  </li>
                ))}
                {col.items.length === 0 && (
                  <li className="rounded-[12px] border border-dashed border-(--glass-border) p-4 text-center text-sm text-fg-3">
                    Nothing here
                  </li>
                )}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <ConvertDialog
        lead={converting}
        onClose={() => setConverting(null)}
        onDone={() => router.refresh()}
      />
    </div>
  );
}

function MoveMenu({
  card,
  columns,
  from,
  onMove,
}: {
  card: Card;
  columns: BoardColumn[];
  from: string;
  onMove: (c: Card, from: string, to: string) => void;
}) {
  const options = columns.filter(
    (c) => c.id !== from && (card.type === "lead" || c.kind === "case"),
  );
  return (
    <label className="mt-3 flex items-center gap-2 text-xs text-fg-3">
      <GripVerticalIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">
        Move {card.type === "lead" ? card.claimantName : card.caseCode} to
      </span>
      <select
        value=""
        onChange={(e) => e.target.value && onMove(card, from, e.target.value)}
        className="min-h-9 w-full rounded-md border border-(--glass-border) bg-(--glass-elevated) px-2 text-sm text-fg-2 [&>option]:bg-ink-850"
      >
        <option value="">Move to…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.kind === "case" && card.type === "lead" ? `Open case: ${o.label}` : o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function LeadCardView({
  card,
  team,
  columns,
  from,
  onMove,
  onAssign,
  busy,
}: {
  card: LeadCard;
  team: TeamMember[];
  columns: BoardColumn[];
  from: string;
  onMove: (c: Card, from: string, to: string) => void;
  onAssign: (c: LeadCard, id: string) => void;
  busy: boolean;
}) {
  return (
    <>
      {card.reviewAlert === "DUPLICATE_CLAIMANT_REVIEW" && (
        <DuplicateClaimantAlert leadId={card.id} />
      )}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">{card.claimantName}</h3>
        {busy && <LoaderCircleIcon className="size-4 animate-spin text-fg-3" aria-label="Saving" />}
      </div>
      <p className="mt-0.5 text-sm text-fg-2">
        {card.relationship} · {card.certificates}
      </p>
      <a
        href={`tel:${card.phone}`}
        className="mt-1 inline-flex items-center gap-1.5 text-sm text-fg-2 hover:text-fg tnum"
      >
        <PhoneIcon className="size-3.5" aria-hidden="true" />
        {card.phone}
        {card.phoneVerified ? (
          <BadgeCheckIcon
            className="size-3.5 text-confirmed"
            aria-label={
              card.phoneVerifiedBy === "CALL" ? "Phone verified on a call" : "Phone verified"
            }
          />
        ) : (
          <span className="text-pending">unverified</span>
        )}
      </a>
      <CallVerification card={card} />
      {card.holdings.length > 0 && (
        <ul className="mt-2 grid gap-1 border-t border-(--glass-border) pt-2 text-sm">
          {card.holdings.slice(0, 3).map((h) => (
            <li
              key={h.folioId}
              className="flex flex-wrap items-center justify-between gap-1 text-fg-2"
            >
              <span>
                <span className="text-fg">{h.holder}</span> · {h.company}
              </span>
              {h.folioReleased ? (
                <span className="text-xs text-confirmed">folio released</span>
              ) : (
                <ReleaseFolioButton leadId={card.id} folioId={h.folioId} />
              )}
            </li>
          ))}
          {card.holdings.length > 3 && (
            <li className="text-fg-3">and {card.holdings.length - 3} more</li>
          )}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {card.estimatedValuePaise > 0 && (
          <span className="font-semibold text-fg tnum">
            {formatPaiseCompact(card.estimatedValuePaise)}
          </span>
        )}
        {card.associate && (
          <StatusBadge tone="iepf" live={false}>
            {card.associate.referralCode}
          </StatusBadge>
        )}
      </div>
      <label className="mt-3 flex items-center gap-2 text-xs text-fg-3">
        <UserRoundIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="sr-only">Assigned analyst for {card.claimantName}</span>
        <select
          value={card.assignedAnalyst?.id ?? ""}
          onChange={(e) => onAssign(card, e.target.value)}
          className="min-h-9 w-full rounded-md border border-(--glass-border) bg-(--glass-elevated) px-2 text-sm text-fg-2 [&>option]:bg-ink-850"
        >
          <option value="">Unassigned</option>
          {team.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <MoveMenu card={card} columns={columns} from={from} onMove={onMove} />
      {card.unlockedAt && (
        <p className="mt-2 text-xs text-fg-3">Claim requested {formatDate(card.unlockedAt)}</p>
      )}
    </>
  );
}

/**
 * Verification by phone while sign-in codes cannot be texted: the analyst
 * calls the number, records what the call confirmed, and may then read out a
 * one-time sign-in code so the claimant can open their account.
 */
function CallVerification({ card }: { card: LeadCard }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!card.phoneVerified)
    return (
      <div className="mt-1 text-xs">
        <button
          type="button"
          className="link text-fg-2 disabled:opacity-60"
          disabled={busy}
          onClick={() => {
            const note = window.prompt(
              `You called ${card.phone}. What did the call confirm? (who answered, details checked)`,
            );
            if (!note?.trim()) return;
            void run(async () => {
              await callApi(`crm/leads/${card.id}/verify-call`, { body: { note: note.trim() } });
              router.refresh();
            });
          }}
        >
          {busy ? "Saving…" : "Verified on a call"}
        </button>
        {error && <p className="text-blocker">{error}</p>}
      </div>
    );

  return (
    <div className="mt-1 text-xs">
      {issued ? (
        <p className="rounded-md border border-(--glass-border) bg-(--glass-elevated) px-2 py-1.5 text-fg-2">
          Read out on the call:{" "}
          <span className="font-mono text-base tracking-[0.3em] text-fg tnum">{issued.code}</span>
          <br />
          Works once at /login, until {formatDateTime(issued.expiresAt)}. It is not shown again.
        </p>
      ) : (
        <button
          type="button"
          className="link text-fg-2 disabled:opacity-60"
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `Issue a one-time sign-in code for ${card.phone}? Read it out only on a call to this number.`,
              )
            )
              return;
            void run(async () => {
              setIssued(
                await callApi<{ code: string; expiresAt: string }>(
                  `crm/leads/${card.id}/sign-in-code`,
                  { method: "POST" },
                ),
              );
            });
          }}
        >
          {busy ? "Issuing…" : "Issue sign-in code"}
        </button>
      )}
      {error && <p className="text-blocker">{error}</p>}
    </div>
  );
}

/** Another client already claims one of these holdings: verify both before going on. */
function DuplicateClaimantAlert({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <div
      role="alert"
      className="mb-2 rounded-md border border-blocker/40 bg-blocker-wash px-2 py-1.5 text-xs text-fg"
    >
      <p className="font-semibold">Duplicate claimant: review</p>
      <p className="text-fg-2">
        Another client claims one of these holdings. Verify both families first.
      </p>
      <button
        type="button"
        className="link mt-1 text-fg-2 disabled:opacity-60"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await callApi(`crm/leads/${leadId}`, {
              method: "PATCH",
              body: { clearReviewAlert: true },
            });
            router.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : "Mark reviewed"}
      </button>
    </div>
  );
}

/** Shows the claimant one holding's folio number; until then it stays masked for them. */
function ReleaseFolioButton({ leadId, folioId }: { leadId: string; folioId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className="link text-xs text-fg-2 disabled:opacity-60"
      disabled={busy}
      onClick={async () => {
        // A reviewed decision: the reason goes into the audit log.
        const reason = window.prompt(
          "Why may this claimant see the folio number? (documents checked, relationship)",
        );
        if (!reason?.trim()) return;
        setBusy(true);
        const send = (competingClaimReview?: string) =>
          callApi(`crm/leads/${leadId}/release-folios`, {
            body: { folioIds: [folioId], reason: reason.trim(), competingClaimReview },
          });
        try {
          try {
            await send();
          } catch (e) {
            // Someone else also claims this holding: the reviewer must record the outcome.
            if (!(e instanceof ClientApiError && e.status === 409)) throw e;
            const outcome = window.prompt(
              `${e.message}\n\nIf you have reviewed both claims, record the outcome:`,
            );
            if (!outcome?.trim()) return;
            await send(outcome.trim());
          }
          router.refresh();
        } catch (e) {
          window.alert((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Releasing…" : "Release folio"}
    </button>
  );
}

function CaseCardView({
  card,
  columns,
  from,
  onMove,
  busy,
}: {
  card: CaseCard;
  columns: BoardColumn[];
  from: string;
  onMove: (c: Card, from: string, to: string) => void;
  busy: boolean;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/portal/cases/${card.caseCode}`}
          className="link inline-flex items-center gap-1 font-mono text-sm tnum"
        >
          {card.caseCode}
          <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
        {busy && <LoaderCircleIcon className="size-4 animate-spin text-fg-3" aria-label="Saving" />}
      </div>
      <h3 className="mt-1 text-base font-semibold text-fg">{card.clientName}</h3>
      <p className="text-sm text-fg-2">{card.companyName}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StatusBadge tone="active" live={false}>
          {card.recoverStep}. {card.recoverStepName}
        </StatusBadge>
        <StatusBadge tone={card.esignStatus === "SIGNED" ? "success" : "neutral"} live={false}>
          eSign {card.esignStatus === "SIGNED" ? "signed" : "pending"}
        </StatusBadge>
      </div>
      <dl className="mt-2 grid gap-0.5 text-xs text-fg-3">
        <div className="flex justify-between gap-2">
          <dt>Fee</dt>
          <dd className="text-fg-2 tnum">
            {card.feePct === null ? (
              <span className="text-pending">quote pending</span>
            ) : (
              `${card.feePct}%`
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>SRN</dt>
          <dd className="font-mono text-fg-2">{card.mcaIepf5Srn ?? "not filed"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Nodal</dt>
          <dd className="text-fg-2">{TRACK_LABELS[card.nodalVerificationStatus]}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Demat</dt>
          <dd className="text-fg-2">{TRACK_LABELS[card.dematCreditStatus]}</dd>
        </div>
      </dl>
      <MoveMenu card={card} columns={columns} from={from} onMove={onMove} />
    </>
  );
}

function ConvertDialog({
  lead,
  onClose,
  onDone,
}: {
  lead: LeadCard | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [folioId, setFolioId] = React.useState("");
  const [scenario, setScenario] = React.useState<ScenarioType>("STANDARD_IEPF5");
  const [fee, setFee] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<string | null>(null);

  const [forLead, setForLead] = React.useState(lead);
  if (forLead !== lead) {
    setForLead(lead);
    setFolioId(lead?.holdings[0]?.folioId ?? "");
    setError(null);
    setCreated(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lead) return;
    setBusy(true);
    setError(null);
    try {
      const res = await callApi<{ caseCode: string }>(`crm/leads/${lead.id}/convert`, {
        body: {
          folioId,
          scenarioType: scenario,
          agreedSuccessFeePct: fee ? Number(fee) : null,
        },
      });
      setCreated(res.caseCode);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogTitle>Open a case for {lead?.claimantName}</DialogTitle>
        <DialogDescription>
          The client gets a portal account on this phone number and sees the case at once.
        </DialogDescription>
        {created ? (
          <div className="mt-5 grid gap-4">
            <Alert variant="confirmed">
              <AlertDescription>
                Case <span className="font-mono">{created}</span> is open.
              </AlertDescription>
            </Alert>
            <Button asChild>
              <Link href={`/portal/cases/${created}`}>Go to the case</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-5 grid gap-4">
            {error && (
              <Alert variant="blocker" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!lead?.phoneVerified && (
              <Alert variant="pending">
                <AlertDescription>
                  This lead&apos;s phone is not verified yet. Ask them to sign in through the Login
                  Gateway first.
                </AlertDescription>
              </Alert>
            )}
            <div>
              <label htmlFor="c-folio" className="mb-1.5 block text-sm text-fg-2">
                Holding
              </label>
              <Select
                id="c-folio"
                value={folioId}
                onChange={(e) => setFolioId(e.target.value)}
                required
              >
                {lead?.holdings.map((h) => (
                  <option key={h.folioId} value={h.folioId}>
                    {h.holder} · {h.company}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <div>
                <label htmlFor="c-scenario" className="mb-1.5 block text-sm text-fg-2">
                  Route
                </label>
                <Select
                  id="c-scenario"
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value as ScenarioType)}
                >
                  {SCENARIO_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {SCENARIO_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label htmlFor="c-fee" className="mb-1.5 block text-sm text-fg-2">
                  Custom fee %
                </label>
                <Input
                  id="c-fee"
                  inputMode="decimal"
                  placeholder="Later"
                  value={fee}
                  onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))}
                  className="tnum"
                />
              </div>
            </div>
            <Button type="submit" size="lg" disabled={busy || !folioId || !lead?.phoneVerified}>
              {busy && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              Open case
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
