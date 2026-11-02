"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  DownloadIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import {
  claimEstimate,
  describeQuote,
  MIN_PURCHASE_YEAR,
  POPULAR_EXAMPLES,
  portfolioTotals,
  VALUATION_ASSUMPTIONS,
  valueEquityHolding,
  type CorporateActionLike,
  type HoldingValuation,
} from "@finsol/shared";

import { CorporateActionTimeline, NetValueScorecard } from "@/components/calculator/scorecard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { readWho } from "@/components/auth/account-link";
import { LoginGatewayDialog } from "@/components/auth/login-gateway-dialog";
import { CHECK_CTA } from "@/components/site/cta";
import { callApi, ClientApiError } from "@/lib/api/client";
import { formatCount, formatPaise, formatPaiseCompact, formatPaisePlus } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Listing {
  symbol: string;
  name: string;
  exchange: "NSE" | "BSE";
}

interface EquityDetail extends Listing {
  price: number | null;
  priceQuoteAt: string | null;
  priceRetrievedAt: string | null;
  priceUpdatedAt: string | null;
  priceSource: string | null;
  priceError: string | null;
  priceAttemptedAt: string | null;
  actionsKnown: boolean;
  actions: CorporateActionLike[];
  actionsBasis: "verified" | "exchange";
  dividends: { exDate: string; amount: number }[];
  historyFrom: string | null;
  spinOffs: { recordDate: string; symbol: string | null; name: string; price: number | null }[];
}

interface Row {
  key: string;
  detail: EquityDetail;
  valuation: HoldingValuation;
}

const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: THIS_YEAR - MIN_PURCHASE_YEAR + 1 }, (_, i) => THIS_YEAR - i);

async function loadEquity(l: Pick<Listing, "symbol" | "exchange">, fresh = false) {
  return callApi<EquityDetail>(
    `market/equities/${l.exchange}/${encodeURIComponent(l.symbol)}${fresh ? "?fresh=1" : ""}`,
  );
}

function value(
  detail: EquityDetail,
  year: number,
  shares: number,
  price: number | null,
  manual: boolean,
) {
  return valueEquityHolding(
    {
      symbol: detail.symbol,
      exchange: detail.exchange,
      name: detail.name,
      purchaseYear: year,
      originalShares: shares,
      pricePerShare: usablePrice(price),
      priceIsManual: manual,
    },
    // Older API builds send neither field: no demergers, history complete.
    { ...detail, historyFrom: detail.historyFrom ?? null, spinOffs: detail.spinOffs ?? [] },
  );
}

/** A price the calculator can use: finite and above zero, else unknown (never NaN or ₹0). */
function usablePrice(p: number | null | undefined): number | null {
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/** The same price description the company page and the PDF use. */
function quoteOf(d: EquityDetail, manual: boolean, price: number | null) {
  return describeQuote({
    price,
    quoteAt: d.priceQuoteAt,
    retrievedAt: d.priceRetrievedAt,
    attemptedAt: d.priceAttemptedAt,
    error: d.priceError,
    manual,
    source: d.priceSource,
  });
}

/** "₹1.2 lakh", or "Not available" when there is no price (never ₹0). */
const valueText = (paise: number | null, compact = true) =>
  paise === null ? "Not available" : compact ? formatPaiseCompact(paise) : formatPaise(paise);

/** "25,600" or "12,800–25,600" when events in the purchase year make it depend on the date. */
const sharesText = (v: HoldingValuation) =>
  v.currentSharesRange.min === v.currentSharesRange.max
    ? formatCount(v.currentShares)
    : `${formatCount(v.currentSharesRange.min)}–${formatCount(v.currentShares)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const growth = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(x % 1 ? 1 : 0)}x`;

/**
 * One-click examples. Labels are never typed in: each is computed with the
 * same valueHolding() call the calculator uses, from the verified history
 * and the latest available price, so a pill always matches the result it adds.
 */
function QuickTry({ onPick }: { onPick: (d: EquityDetail, year: number, shares: number) => void }) {
  const [details, setDetails] = React.useState<Record<string, EquityDetail>>({});
  React.useEffect(() => {
    let live = true;
    for (const e of POPULAR_EXAMPLES)
      loadEquity({ symbol: e.symbol, exchange: "NSE" })
        .then((d) => live && setDetails((s) => ({ ...s, [e.symbol]: d })))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <section aria-labelledby="quick-heading">
      <h2 id="quick-heading" className="text-sm font-medium text-fg-2">
        Quick try: blue chips with large unclaimed holdings
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {POPULAR_EXAMPLES.map((e) => {
          const d = details[e.symbol];
          const v = d ? value(d, e.year, e.shares, d.price, false) : null;
          return (
            <li key={e.symbol}>
              <button
                type="button"
                disabled={!d}
                onClick={() => d && onPick(d, e.year, e.shares)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-(--glass-border) bg-(--glass-elevated) px-3.5 py-2 text-left text-sm text-fg-2 transition-colors duration-150 hover:border-signal/60 hover:text-fg disabled:opacity-60"
              >
                <ZapIcon className="size-3.5 shrink-0 text-signal" aria-hidden="true" />
                <span>
                  <span className="font-medium text-fg">{e.label}:</span> {e.shares} in {e.year}
                  {v ? (
                    <>
                      {" "}
                      → <span className="tnum">{sharesText(v)}</span> shares
                      {v.marketValuePaise !== null ? (
                        <>
                          {" "}
                          = <span className="tnum">{formatPaisePlus(v.marketValuePaise)}</span>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-fg-3"> (calculating…)</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Company picker: NSE-listed equities, plus BSE listings found live. */
function CompanyPicker({
  selected,
  onSelect,
}: {
  selected: Listing | null;
  onSelect: (l: Listing) => void;
}) {
  const [q, setQ] = React.useState(selected?.name ?? "");
  const [results, setResults] = React.useState<Listing[]>([]);
  const [size, setSize] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const listId = React.useId();

  // Keep the box in step when a quick-try pill picks a company.
  const [lastSelected, setLastSelected] = React.useState(selected);
  if (selected !== lastSelected) {
    setLastSelected(selected);
    setQ(selected?.name ?? "");
  }

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      callApi<{ directorySize: number; results: Listing[] }>(
        `market/equities?q=${encodeURIComponent(q)}`,
      )
        .then((r) => {
          setResults(r.results);
          setSize(r.directorySize);
          setActive(0);
        })
        .catch(() => setResults([]));
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const choose = (l: Listing) => {
    onSelect(l);
    setQ(l.name);
    setOpen(false);
  };

  return (
    <div className="relative">
      <label htmlFor="calc-company" className="mb-1.5 block text-sm text-fg-2">
        1. Company Name *
      </label>
      <Input
        id="calc-company"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Search any NSE or BSE company"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open && results[active]) {
            e.preventDefault();
            choose(results[active]!);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {size !== null && (
        <p className="mt-1 text-xs text-fg-3">
          {formatCount(size)} NSE equities, plus BSE listings looked up live.
        </p>
      )}
      {open && results.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="vault-glass absolute inset-x-0 top-[4.75rem] z-20 max-h-72 overflow-y-auto rounded-[12px] p-1"
        >
          {results.map((r, i) => (
            <li
              key={`${r.exchange}:${r.symbol}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(r);
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-sm",
                i === active ? "bg-signal/15 text-fg" : "text-fg-2",
              )}
            >
              <span className="min-w-0 truncate">{r.name}</span>
              <span className="shrink-0 font-mono text-xs text-fg-3">
                {r.exchange}: {r.symbol}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The Family Wealth Calculator: add each stock the family held, see shares
 * today after every bonus and split, an estimated market value at the latest
 * available price, and (separately) the dividends declared since purchase.
 * Computed in the browser with the same shared rules the API uses for the
 * PDF, so Quick Try labels, totals and the report agree.
 */
export function Calculator() {
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [detail, setDetail] = React.useState<EquityDetail | null>(null);
  const [year, setYear] = React.useState(2000);
  const [shares, setShares] = React.useState("100");
  const [price, setPrice] = React.useState("");
  const [manual, setManual] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [gateway, setGateway] = React.useState(false);
  const [report, setReport] = React.useState<{ busy: boolean; message: string | null }>({
    busy: false,
    message: null,
  });

  async function select(l: Listing, fresh = false) {
    setListing(l);
    setLoading(true);
    setError(null);
    try {
      const d = await loadEquity(l, fresh);
      setDetail(d);
      setPrice(d.price === null ? "" : String(d.price));
      setManual(false);
    } catch (e) {
      setDetail(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const original = Math.max(0, Math.min(10_000_000, Math.floor(Number(shares) || 0)));
  const priceNum = usablePrice(price === "" ? null : Number(price));
  const preview = detail && original > 0 ? value(detail, year, original, priceNum, manual) : null;

  function add(d = detail, y = year, s = original, p = priceNum, m = manual) {
    if (!d || s <= 0) return;
    setRows((r) => [
      ...r,
      {
        key: `${d.exchange}:${d.symbol}:${y}:${Date.now()}`,
        detail: d,
        valuation: value(d, y, s, p, m),
      },
    ]);
  }

  function quickTry(d: EquityDetail, y: number, s: number) {
    setListing(d);
    setDetail(d);
    setYear(y);
    setShares(String(s));
    setPrice(d.price === null ? "" : String(d.price));
    setManual(false);
    add(d, y, s, d.price, false);
  }

  const totals = portfolioTotals(rows.map((r) => r.valuation));
  const estimate = claimEstimate(totals);
  const [openTimeline, setOpenTimeline] = React.useState<string | null>(null);

  async function downloadReport() {
    // Signed-out visitors go straight to the gateway; the API checks the session either way.
    if (!readWho(document.cookie)) {
      setGateway(true);
      return;
    }
    setReport({ busy: true, message: null });
    try {
      const res = await fetch("/api/v1/valuation/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          holdings: rows.map((r) => ({
            symbol: r.valuation.symbol,
            exchange: r.valuation.exchange,
            purchaseYear: r.valuation.purchaseYear,
            originalShares: r.valuation.originalShares,
            manualPrice: r.valuation.priceIsManual ? r.valuation.pricePerShare : null,
          })),
        }),
      });
      if (res.status === 401) {
        setGateway(true);
        setReport({ busy: false, message: null });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new ClientApiError(res.status, body?.message ?? "The report could not be created.");
      }
      const code = res.headers.get("x-report-code") ?? "FE-VAL";
      const left = res.headers.get("x-reports-left-today");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${code}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setReport({
        busy: false,
        message: `Report ${code} downloaded.${left !== null ? ` ${left} more today on this mobile number.` : ""}`,
      });
    } catch (e) {
      setReport({ busy: false, message: (e as Error).message });
    }
  }

  return (
    <div className="grid gap-8">
      <QuickTry onPick={quickTry} />

      <form
        className="panel grid gap-5 p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <h2 className="text-lg font-semibold text-fg">Add Stock Holding</h2>
        {error && (
          <Alert variant="blocker" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <CompanyPicker selected={listing} onSelect={(l) => void select(l)} />
          <div>
            <label htmlFor="calc-year" className="mb-1.5 block text-sm text-fg-2">
              2. Exact Purchase Year * ({MIN_PURCHASE_YEAR}–{THIS_YEAR})
            </label>
            <Select id="calc-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {YEARS.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="calc-shares" className="mb-1.5 block text-sm text-fg-2">
              3. Original Shares *
            </label>
            <Input
              id="calc-shares"
              required
              inputMode="numeric"
              value={shares}
              onChange={(e) => setShares(e.target.value.replace(/\D/g, ""))}
              className="tnum"
            />
          </div>
          <div>
            <label htmlFor="calc-price" className="mb-1.5 block text-sm text-fg-2">
              4. Current Price per Share (₹)
            </label>
            <div className="flex gap-2">
              <Input
                id="calc-price"
                inputMode="decimal"
                value={price}
                placeholder={detail ? "Price unavailable" : "Pick a company"}
                onChange={(e) => {
                  setPrice(e.target.value.replace(/[^\d.]/g, ""));
                  setManual(true);
                }}
                className="tnum"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0 whitespace-nowrap"
                disabled={!listing || loading}
                onClick={() => listing && void select(listing, true)}
              >
                {loading ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCwIcon aria-hidden="true" />
                )}
                ₹ Sync
              </Button>
            </div>
            <p className="mt-1 text-xs text-fg-3" aria-live="polite">
              {detail ? (
                <>
                  <span className="font-medium text-fg-2">
                    {quoteOf(detail, manual, priceNum).label}.
                  </span>{" "}
                  {quoteOf(detail, manual, priceNum).detail}
                </>
              ) : (
                "Fetched from market data when available; you can type a price."
              )}
            </p>
          </div>
        </div>
        {detail && (
          <p className="text-sm text-fg-2">
            Recorded Corporate Actions (Splits &amp; Bonuses):{" "}
            <span className="font-semibold text-fg tnum">
              {plural(preview?.events ?? 0, "event")}
            </span>{" "}
            since {year}
            <span className="text-fg-3">
              {" "}
              ·{" "}
              {!detail.actionsKnown
                ? "no history available, so shares are not adjusted"
                : detail.actionsBasis === "verified"
                  ? "history checked against company filings"
                  : "from the exchange record"}
            </span>
            {preview && (
              <>
                {" "}
                →{" "}
                <span className="font-semibold text-fg tnum">
                  {sharesText(preview)} shares today
                </span>
              </>
            )}
          </p>
        )}
        {preview && preview.timeline.length > 0 && <CorporateActionTimeline valuation={preview} />}
        {preview && preview.assumptions.length > 0 && (
          <ul className="grid gap-1 text-sm text-pending">
            {preview.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        <div>
          <Button type="submit" size="lg" disabled={!detail || original <= 0}>
            <PlusIcon aria-hidden="true" />
            Add to Wealth Calculation
          </Button>
        </div>
      </form>

      <section aria-labelledby="holdings-heading" className="grid gap-4">
        <h2 id="holdings-heading" className="text-xl font-semibold text-fg">
          Your Calculated Holdings
        </h2>
        {rows.length === 0 ? (
          <p className="panel p-5 text-fg-2">
            Nothing added yet. Try a popular stock above, or add your own.
          </p>
        ) : (
          <>
            <NetValueScorecard totals={totals} estimate={estimate} />
            <ul className="grid gap-3">
              {rows.map((r) => (
                <li
                  key={r.key}
                  className="panel grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-fg">
                      {r.valuation.name}{" "}
                      <span className="font-mono text-xs text-fg-3">
                        {r.valuation.exchange}: {r.valuation.symbol}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-fg-2 tnum">
                      {formatCount(r.valuation.originalShares)} in {r.valuation.purchaseYear} →{" "}
                      {sharesText(r.valuation)} shares ({growth(r.valuation.growthMultiple)},{" "}
                      {plural(r.valuation.events, "event")}) ·{" "}
                      {r.valuation.pricePerShare === null
                        ? "no price"
                        : `${formatPaise(Math.round(r.valuation.pricePerShare * 100), { exact: true })}/share${r.valuation.priceIsManual ? " (entered by you)" : ""}`}
                    </p>
                    <p className="mt-1 text-sm text-fg-3 tnum">
                      {r.valuation.priceIsManual
                        ? "Your price"
                        : quoteOf(r.detail, false, r.valuation.pricePerShare).label}{" "}
                      · dividends declared while held {formatPaise(r.valuation.dividendPaise)} (not
                      included)
                    </p>
                    {r.valuation.spinOffs.map((so) => (
                      <p key={so.symbol} className="mt-1 text-sm text-fg-2 tnum">
                        + {formatCount(so.shares)} {so.name} shares from the{" "}
                        {so.recordDate.slice(0, 4)} demerger ·{" "}
                        {so.marketValuePaise === null
                          ? "no price"
                          : formatPaiseCompact(so.marketValuePaise)}
                      </p>
                    ))}
                    {r.valuation.assumptions.map((a) => (
                      <p key={a} className="mt-1 text-sm text-pending">
                        {a}
                      </p>
                    ))}
                    {r.valuation.timeline.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="mt-2 text-sm font-medium text-signal underline-offset-4 hover:underline"
                          aria-expanded={openTimeline === r.key}
                          onClick={() => setOpenTimeline((k) => (k === r.key ? null : r.key))}
                        >
                          {openTimeline === r.key ? "Hide" : "Show"} corporate action timeline (
                          {plural(r.valuation.timeline.length, "event")})
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3 sm:justify-end">
                    <span className="text-lg font-semibold text-fg tnum">
                      {valueText(r.valuation.totalPaise)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${r.valuation.name}`}
                      onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                  {openTimeline === r.key && (
                    <CorporateActionTimeline valuation={r.valuation} className="sm:col-span-2" />
                  )}
                </li>
              ))}
            </ul>
            <div className="panel flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="flex items-center gap-2 font-semibold text-fg">
                  <FileTextIcon className="size-4 text-signal" aria-hidden="true" />
                  Valuation Dossier (PDF)
                </p>
                <p className="mt-1 text-sm text-fg-3">
                  Branded report with a Report ID, price times, each holding&apos;s corporate action
                  breakdown, the net value scorecard, the documents a recovery needs and the next
                  steps. An estimate, not a certified valuation. Free after a sign-in; two a day per
                  mobile number.
                </p>
                {report.message && (
                  <p className="mt-2 text-sm text-fg-2" role="status">
                    {report.message}
                  </p>
                )}
              </div>
              <Button
                onClick={downloadReport}
                disabled={report.busy}
                className="shrink-0 whitespace-nowrap"
              >
                {report.busy ? (
                  <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                ) : (
                  <DownloadIcon aria-hidden="true" />
                )}
                Download Valuation Dossier
              </Button>
            </div>
            <div className="panel flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-fg-2">
                Are any of these unclaimed? Check the family&apos;s name in three minutes.
              </p>
              <Button asChild variant="outline">
                <Link href="/search">
                  <SearchIcon aria-hidden="true" />
                  {CHECK_CTA}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </>
        )}
        <div className="text-sm text-fg-3">
          <p className="font-medium text-fg-2">Assumptions</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {VALUATION_ASSUMPTIONS.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </section>

      <LoginGatewayDialog
        open={gateway}
        onOpenChange={setGateway}
        reason="to download your Valuation Dossier"
        onSignedIn={() => void downloadReport()}
      />
    </div>
  );
}
