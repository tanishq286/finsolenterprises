import { GitBranchIcon, LayersIcon, ScissorsIcon, ShoppingBagIcon, SplitIcon } from "lucide-react";
import {
  type ClaimEstimate,
  type HoldingValuation,
  type PortfolioTotals,
  type TimelineStep,
} from "@finsol/shared";

import { formatCount, formatPaise, formatPaiseCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICON: Record<TimelineStep["kind"], typeof LayersIcon> = {
  BONUS: LayersIcon,
  SPLIT: ScissorsIcon,
  MERGER: GitBranchIcon,
  DEMERGER: SplitIcon,
};

/**
 * The corporate-action multiplier, step by step: shares bought, then every
 * bonus, split, merger and demerger since, with the count after each one.
 * Horizontal on wide screens, vertical on phones.
 */
export function CorporateActionTimeline({
  valuation: v,
  className,
}: {
  valuation: HoldingValuation;
  className?: string;
}) {
  const fmtDate = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return (
    <figure className={cn("rounded-[14px] border border-line bg-white p-4", className)}>
      <figcaption className="text-sm font-medium text-fg">
        {v.name}: {formatCount(v.originalShares)} shares in {v.purchaseYear} →{" "}
        <span className="text-signal tnum">{formatCount(v.currentShares)} today</span>
        {v.spinOffs.length > 0 && (
          <span className="text-fg-2">
            {" "}
            + {v.spinOffs.map((s) => `${formatCount(s.shares)} ${s.symbol}`).join(" + ")}
          </span>
        )}
      </figcaption>
      <ol
        className="mt-4 grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] sm:gap-x-4 sm:gap-y-5"
        aria-label={`Corporate action timeline for ${v.name}`}
      >
        <TimelineNode
          icon={ShoppingBagIcon}
          when={String(v.purchaseYear)}
          title="Bought"
          value={`${formatCount(v.originalShares)} shares`}
          first
        />
        {v.timeline.map((t) => {
          const demerger = t.kind === "DEMERGER";
          return (
            <TimelineNode
              key={`${t.date}:${t.label}`}
              icon={ICON[t.kind]}
              when={fmtDate(t.date)}
              title={t.label}
              value={
                demerger
                  ? t.receivedShares
                    ? `+${formatCount(t.receivedShares)} ${t.receivedSymbol}`
                    : "Checked by your analyst"
                  : `${formatCount(t.sharesAfter)} shares`
              }
              detail={
                demerger
                  ? `On ${formatCount(t.sharesBefore)} held`
                  : t.sharesBefore > 0
                    ? `×${(t.sharesAfter / t.sharesBefore).toFixed(t.sharesAfter % t.sharesBefore ? 2 : 0)}`
                    : undefined
              }
              tone={demerger ? "iepf" : "signal"}
              source={t.source}
            />
          );
        })}
      </ol>
    </figure>
  );
}

function TimelineNode({
  icon: Icon,
  when,
  title,
  value,
  detail,
  tone = "signal",
  first = false,
  source,
}: {
  icon: typeof LayersIcon;
  when: string;
  title: string;
  value: string;
  detail?: string;
  tone?: "signal" | "iepf";
  first?: boolean;
  source?: string | null;
}) {
  return (
    <li className="relative flex min-w-0 gap-3 sm:flex-col sm:gap-2">
      {/* Phones: a vertical line links each step to the one before. */}
      {!first && (
        <span
          aria-hidden="true"
          className="absolute -top-3 left-[15px] h-3 w-px bg-line sm:hidden"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border",
          tone === "iepf"
            ? "border-iepf/30 bg-iepf-wash text-iepf"
            : first
              ? "border-line bg-ink-900 text-fg-2"
              : "border-signal/30 bg-signal-wash text-signal",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0" title={source ?? undefined}>
        <p className="text-xs font-medium tracking-wide text-fg-3 uppercase">{when}</p>
        <p className="text-sm text-fg-2">{title}</p>
        <p className="font-semibold text-fg tnum">
          {value}
          {detail && <span className="ml-1.5 text-xs font-medium text-fg-3">{detail}</span>}
        </p>
      </div>
    </li>
  );
}

/**
 * The value scorecard: gross value, accrued dividends and the headline Total
 * Claimable Wealth. Pricing is custom per case (quoted in the engagement
 * letter), so no fee percentage or net-of-fee figure is shown to the public.
 * Statutory and documentation costs vary by state, so they are "at actuals".
 */
export function NetValueScorecard({
  totals,
  estimate: e,
}: {
  totals: PortfolioTotals;
  estimate: ClaimEstimate;
}) {
  const growth =
    totals.growthMultiple >= 10
      ? Math.round(totals.growthMultiple)
      : totals.growthMultiple.toFixed(totals.growthMultiple % 1 ? 1 : 0);
  return (
    <section
      aria-labelledby="scorecard-heading"
      className="overflow-hidden rounded-[20px] border border-line bg-white shadow-sm"
    >
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[1fr_1.15fr]">
        <div>
          <h3 id="scorecard-heading" className="text-sm font-medium text-fg-3">
            Total Claimable Wealth
          </h3>
          <p className="display mt-1 text-[clamp(2rem,4.2vw,3rem)] text-fg tnum">
            {formatPaiseCompact(e.totalClaimablePaise)}
          </p>
          <p className="mt-1 text-sm text-fg-2 tnum">{formatPaise(e.totalClaimablePaise)}</p>
          <p className="mt-4 text-sm text-fg-2 tnum">
            {formatCount(totals.originalShares)} shares bought →{" "}
            <span className="font-semibold text-fg">{formatCount(totals.currentShares)}</span> today
            ({growth}x)
          </p>
          {!e.complete && (
            <p className="mt-2 text-sm text-pending">
              {totals.unvaluedLines} holding{totals.unvaluedLines > 1 ? "s have" : " has"} no price,
              so these figures understate the total.
            </p>
          )}
        </div>
        <dl className="grid gap-0 text-sm">
          <Line
            label="Gross current market value"
            hint="Adjusted shares × current price, incl. demerged holdings"
          >
            {formatPaise(e.grossMarketValuePaise)}
          </Line>
          <Line
            label="Estimated accrued dividends"
            hint={`If none were encashed: ${formatPaiseCompact(totals.dividendsWithCompanyPaise)} with the companies (last 7 years), ${formatPaiseCompact(totals.dividendsWithIepfPaise)} with the IEPF`}
          >
            {formatPaise(e.accruedDividendsPaise)}
          </Line>
          <Line label="Total Claimable Wealth" strong>
            {formatPaise(e.totalClaimablePaise)}
          </Line>
          <Line
            label="Success-Based Fee: Custom (Zero Upfront — Quoted per Engagement Letter)"
            hint="Charged only on value actually credited to you."
          >
            ₹0 upfront
          </Line>
          <Line
            label="Statutory & documentation costs"
            hint="Stamp duty on the indemnity bond, notarisation, courier: vary by state"
          >
            At actuals
          </Line>
        </dl>
      </div>
    </section>
  );
}

function Line({
  label,
  hint,
  strong = false,
  children,
}: {
  label: string;
  hint?: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  // A <div> may group one <dt> and its <dd> directly; the hint lives inside the <dt>.
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line py-2.5 last:border-b-0",
        strong && "-mx-2 rounded-[8px] border-b-0 bg-signal-wash px-2",
      )}
    >
      <dt className="min-w-0">
        <span className={cn("block", strong ? "font-semibold text-fg" : "text-fg-2")}>{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-fg-3">{hint}</span>}
      </dt>
      <dd className={cn("shrink-0 text-right tnum", strong ? "font-semibold text-fg" : "text-fg")}>
        {children}
      </dd>
    </div>
  );
}
