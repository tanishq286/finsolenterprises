"use client";

import * as React from "react";
import Link from "next/link";
import {
  CheckIcon,
  HandCoinsIcon,
  KeyRoundIcon,
  LockIcon,
  SendIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  CUSTODY_LABELS,
  folioStateLabel,
  type CustodyStatus,
  type ResultAccess,
  type SearchResultItem,
} from "@finsol/shared";

import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { LoginGatewayDialog } from "@/components/auth/login-gateway-dialog";
import { ClaimDialog } from "@/components/search/claim-dialog";
import { formatCount, formatPaiseCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_SELECT = 10;

const CUSTODY_TONE: Record<CustodyStatus, StatusTone> = {
  IEPF_AUTHORITY: "iepf",
  COMPANY_SUSPENSE: "pending",
  PHYSICAL_DORMANT: "neutral",
  DUE_FOR_IEPF_TRANSFER: "pending",
};

const MATCH_LABEL = {
  exact: "Exact name",
  trigram: "Close spelling",
  phonetic: "Sounds alike",
  "sound-alike": "Similar sound",
} as const;

const CLASS_ORDER = ["exact", "partial", "variant"] as const;
const CLASS_HEADING: Record<(typeof CLASS_ORDER)[number], { title: string; body: string }> = {
  exact: { title: "Exact matches", body: "Every name part you typed matches." },
  partial: {
    title: "Partial matches",
    body: "The one name you typed matches; other names on the record were not checked.",
  },
  variant: {
    title: "Spelling or sound-alike variants",
    body: "Close to what you typed, not the same. Statements often misspell names.",
  },
};

function Fact({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-fg-3">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-base text-fg",
          mono && "tnum font-mono text-[0.9375rem]",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * Results of the 3-Minute Check. The public sees who matched and where;
 * after the Login Gateway, members see the company, shares and value. Folio
 * numbers stay masked until the member's analyst releases them.
 */
export function SearchResults({
  results,
  access,
  referralCode,
}: {
  results: SearchResultItem[];
  access: ResultAccess;
  referralCode?: string;
}) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const [claimOpen, setClaimOpen] = React.useState(false);
  const [gatewayOpen, setGatewayOpen] = React.useState(false);
  // A partner's referral link sets ?ref=; it is kept for later searches in this tab.
  const [ref] = React.useState(() => {
    if (referralCode || typeof window === "undefined") return referralCode;
    try {
      return sessionStorage.getItem("finsol:ref") ?? undefined;
    } catch {
      return undefined;
    }
  });
  React.useEffect(() => {
    try {
      if (referralCode) sessionStorage.setItem("finsol:ref", referralCode);
    } catch {
      /* storage unavailable: the code only lasts for this page */
    }
  }, [referralCode]);

  const isPublic = access === "public";
  // Record groups only group statement lines; they do not establish identity.
  const clusterOf = new Map(results.map((r) => [r.id, r.investorClusterId]));
  const grouped = CLASS_ORDER.map((c) => ({
    cls: c,
    items: results.filter((r) => r.matchClass === c),
  })).filter((g) => g.items.length > 0);
  const selectedPeople = new Set(selected.map((id) => clusterOf.get(id)));
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_SELECT ? s : [...s, id],
    );
  const signIn = (
    <button type="button" className="link font-medium" onClick={() => setGatewayOpen(true)}>
      Sign in to see
    </button>
  );

  return (
    <div>
      {isPublic && (
        <div className="panel mb-5 flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <p className="text-base text-fg-2">
            <LockIcon className="mr-1.5 inline size-4 text-signal" aria-hidden="true" />
            Company names, share counts and values are restricted: they open after a free sign-in.
            Folio numbers stay hidden until our team has verified the claim.
          </p>
          <Button onClick={() => setGatewayOpen(true)}>
            <KeyRoundIcon aria-hidden="true" />
            Open the Login Gateway
          </Button>
        </div>
      )}
      {grouped.map((g) => (
        <section key={g.cls} aria-labelledby={`match-${g.cls}`} className="mb-6">
          <h3 id={`match-${g.cls}`} className="text-base font-semibold text-fg">
            {CLASS_HEADING[g.cls].title} <span className="text-fg-3 tnum">({g.items.length})</span>
          </h3>
          <p className="mb-3 text-sm text-fg-3">{CLASS_HEADING[g.cls].body}</p>
          <ul className="grid gap-3">
            {g.items.map((r) => {
              const isSelected = selected.includes(r.id);
              return (
                <li key={r.id}>
                  <article
                    aria-labelledby={`r-${r.id}`}
                    className={cn(
                      "panel relative grid gap-4 p-4 transition-[border-color,box-shadow] duration-150 sm:p-5",
                      isSelected && "border-signal shadow-[inset_0_0_0_1px_var(--color-signal)]",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3
                          id={`r-${r.id}`}
                          className="flex items-center gap-2 text-lg font-semibold text-fg"
                        >
                          <UserRoundIcon className="size-4 shrink-0 text-fg-3" aria-hidden="true" />
                          {r.investorFullName}
                        </h3>
                        <p className="mt-1 text-sm text-fg-2">
                          {r.fatherOrSpouseName ? (
                            <>Father or spouse: {r.fatherOrSpouseName} · </>
                          ) : null}
                          {[r.city, folioStateLabel(r.state)].filter(Boolean).join(", ")}
                          {r.pincodeMasked ? ` · PIN ${r.pincodeMasked}` : ""}
                        </p>
                        <p className="mt-0.5 text-xs text-fg-3">
                          Record group ID{" "}
                          <span className="font-mono tnum">
                            {r.investorClusterId.slice(0, 8).toUpperCase()}
                          </span>
                          . Different groups may still relate to the same person; identity is
                          verified separately.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <StatusBadge tone={CUSTODY_TONE[r.custodyStatus]} live={false}>
                          {CUSTODY_LABELS[r.custodyStatus]}
                        </StatusBadge>
                        <StatusBadge tone="neutral" live={false}>
                          {r.matchedHolder === "joint"
                            ? "Joint holder match"
                            : MATCH_LABEL[r.matchedBy]}
                        </StatusBadge>
                      </div>
                    </div>

                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                      <Fact label="Company">
                        {r.companySlug ? (
                          <Link href={`/unclaimed-shares/${r.companySlug}`} className="link">
                            {r.companyName}
                          </Link>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <LockIcon className="size-3.5 shrink-0 text-fg-3" aria-hidden="true" />
                            <span aria-label="Company name hidden until you sign in">
                              {r.companyName}
                            </span>
                          </span>
                        )}
                      </Fact>
                      <Fact label="Folio" mono>
                        <span
                          title={
                            r.folioReleased
                              ? undefined
                              : "Shown once your analyst confirms the claim"
                          }
                        >
                          {r.folioNumber}
                        </span>
                      </Fact>
                      {r.recordKind === "UNCLAIMED_AMOUNT" ? (
                        <>
                          <Fact label="Record type">Unclaimed dividend listing</Fact>
                          <Fact label="Amount listed">
                            {r.unclaimedDividendPaise === null ? (
                              signIn
                            ) : (
                              <span className="tnum font-semibold">
                                {formatPaiseCompact(r.unclaimedDividendPaise)}
                              </span>
                            )}
                          </Fact>
                        </>
                      ) : (
                        <>
                          <Fact label="Shares today">
                            {isPublic ? (
                              signIn
                            ) : r.postActionShares === null ? (
                              "Unknown"
                            ) : (
                              <span className="tnum">{formatCount(r.postActionShares)}</span>
                            )}
                          </Fact>
                          <Fact label="Estimated value">
                            {isPublic ? (
                              signIn
                            ) : r.estimatedTotalValuePaise === null ? (
                              "Not available"
                            ) : (
                              <span className="tnum font-semibold">
                                {formatPaiseCompact(r.estimatedTotalValuePaise)}
                              </span>
                            )}
                          </Fact>
                        </>
                      )}
                    </dl>

                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--glass-border) pt-4">
                      <p className="text-sm text-fg-3">
                        {r.recordKind === "UNCLAIMED_AMOUNT"
                          ? "This statement lists an unclaimed dividend amount and no share count. "
                          : ""}
                        {r.transferFinancialYear
                          ? `Recorded for FY ${r.transferFinancialYear}. `
                          : ""}
                        {r.source?.retrievedAt
                          ? `Source retrieved ${new Date(r.source.retrievedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}. `
                          : ""}
                        {isPublic
                          ? "Sign in to see the company, shares and value."
                          : r.folioReleased
                            ? "Folio released by your analyst."
                            : "Your analyst confirms the folio during verification."}
                      </p>
                      {!isPublic && access !== "staff" && (
                        <Button
                          type="button"
                          variant={isSelected ? "secondary" : "outline"}
                          size="sm"
                          aria-pressed={isSelected}
                          onClick={() => toggle(r.id)}
                          disabled={!isSelected && selected.length >= MAX_SELECT}
                        >
                          {isSelected ? (
                            <CheckIcon aria-hidden="true" />
                          ) : (
                            <HandCoinsIcon aria-hidden="true" />
                          )}
                          {isSelected ? "Selected" : "This is my family's"}
                        </Button>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {access === "member" && (
        <div className="sticky bottom-4 z-10 mt-6">
          <div className="vault-glass flex flex-col gap-3 rounded-[16px] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <div aria-live="polite">
              <p className="text-base text-fg-2">
                {selected.length
                  ? `${selected.length} of ${MAX_SELECT} selected.`
                  : "Select the holdings that are your family's. Finsol recovers them end to end."}
              </p>
              {selectedPeople.size > 1 && (
                <p className="mt-1 text-sm text-pending">
                  These are {selectedPeople.size} different record groups (father or spouse, city or
                  PIN differ). They may or may not be the same person; select only records you
                  believe belong to your family, and our team verifies identity.
                </p>
              )}
            </div>
            <Button size="lg" disabled={!selected.length} onClick={() => setClaimOpen(true)}>
              <SendIcon aria-hidden="true" />
              Start free trace{selected.length ? ` (${selected.length})` : ""}
            </Button>
          </div>
        </div>
      )}

      <ClaimDialog
        open={claimOpen}
        onOpenChange={(o) => {
          setClaimOpen(o);
          if (!o) setSelected([]);
        }}
        folioIds={selected}
        referralCode={ref}
      />
      <LoginGatewayDialog open={gatewayOpen} onOpenChange={setGatewayOpen} />
    </div>
  );
}
