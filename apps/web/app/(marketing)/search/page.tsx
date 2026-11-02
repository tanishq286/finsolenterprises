import type { Metadata } from "next";
import Link from "next/link";
import { InfoIcon, RotateCwIcon, SearchXIcon, ServerCrashIcon } from "lucide-react";
import {
  BRAND,
  ALL_INDIA,
  COVERAGE_DISCLAIMER,
  isIndianState,
  STATE_LABELS,
  type SearchResponse,
  type SearchScope,
} from "@finsol/shared";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LiveRefresh } from "@/components/search/live-refresh";
import { CoveragePanel } from "@/components/search/coverage-panel";
import { DeeperTrace } from "@/components/search/deeper-trace";
import { SearchResults } from "@/components/search/search-results";
import { UnclaimedSearchForm } from "@/components/search/unclaimed-search-form";
import { api, ApiError } from "@/lib/api/server";

export const metadata: Metadata = {
  title: "3-Minute Check for unclaimed shares",
  description:
    "Check for unclaimed shares and dividends with just a name and a state. Free, confidential, no folio number needed.",
  // Results name private individuals; keep them out of search engines.
  robots: { index: false, follow: true },
};

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  // `name` is the 3-Minute Check; first/last names still work for links shared earlier.
  const name =
    one(p.name) || [one(p.firstName), one(p.middleName), one(p.lastName)].filter(Boolean).join(" ");
  const joint = one(p.joint);
  const stateRaw = one(p.state);
  const state: SearchScope | "" =
    stateRaw === ALL_INDIA ? ALL_INDIA : isIndianState(stateRaw) ? stateRaw : "";
  const ref = one(p.ref) || undefined;
  const asked = name.length > 0;

  let data: SearchResponse | null = null;
  /** input: fix the form; limited: too many checks; unavailable: our side, retry. */
  let error: { kind: "input" | "limited" | "unavailable"; message: string } | null = null;
  const qs = new URLSearchParams({ state: state || "", fullName: name });
  if (joint) qs.set("jointHolderName", joint);
  if (asked && state) {
    try {
      data = await api<SearchResponse>(`search/unclaimed?${qs}`, {
        session: true,
        timeoutMs: 15_000,
      });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500;
      error =
        status === 429
          ? { kind: "limited", message: (e as Error).message }
          : status < 500
            ? { kind: "input", message: (e as Error).message }
            : {
                kind: "unavailable",
                message:
                  status === 504
                    ? "The check took too long to answer. Nothing was searched, so this is not a “no match”."
                    : "The check is not available right now, so nothing was searched. This is not a “no match”.",
              };
    }
  } else if (asked && !state) {
    error = {
      kind: "input",
      message: "Choose the state on the investor's last known address, or All India.",
    };
  }
  // The same search again, for the retry link.
  const retryHref = `/search?${new URLSearchParams({ name, state: state || "", ...(joint ? { joint } : {}) })}`;

  const who = [name, joint].filter(Boolean).join(" or ");
  const where = !data
    ? ""
    : data.query.state === ALL_INDIA
      ? "all of India"
      : data.query.state === "OUT_OF_INDIA"
        ? "Out of India / NRI"
        : STATE_LABELS[data.query.state];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="display max-w-[20ch] text-[clamp(2rem,4vw,3rem)] text-fg">
        Start your 3-Minute Check
      </h1>
      <p className="mt-4 max-w-[60ch] text-lg text-fg-2">
        Just a name and a state. {BRAND.promise.join(" • ")}.
      </p>
      <UnclaimedSearchForm
        className="mt-8 max-w-[56rem]"
        defaults={{ name, jointHolder: joint, state }}
      />

      <section aria-live="polite" aria-label="Results" className="mt-12">
        {error?.kind === "unavailable" && (
          <Alert variant="blocker" role="alert" data-testid="search-unavailable">
            <ServerCrashIcon aria-hidden="true" />
            <AlertTitle>Search unavailable</AlertTitle>
            <AlertDescription>
              <p>{error.message}</p>
              <Button asChild variant="outline" size="sm" className="mt-3">
                <Link href={retryHref} prefetch={false}>
                  <RotateCwIcon aria-hidden="true" />
                  Try again
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {error && error.kind !== "unavailable" && (
          <Alert variant="pending" role="alert">
            <InfoIcon aria-hidden="true" />
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {data && data.total === 0 && (
          <div className="panel flex flex-col items-start gap-5 p-8 border-2 border-primary/20 bg-card shadow-sm rounded-xl" data-testid="search-no-match">
            <div className="flex items-center gap-3">
              <span className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                <SearchXIcon className="size-6" aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-2xl font-bold text-fg">
                  Instant Search Results for {who} in {where}
                </h2>
                <p className="text-sm text-fg-3">
                  0 direct matches found in current digital index
                </p>
              </div>
            </div>

            <div className="w-full rounded-lg bg-primary/10 p-5 border border-primary/25">
              <p className="text-lg font-semibold text-fg leading-relaxed">
                &ldquo;We searched our instant index of top listed companies. Don&apos;t worry if your name wasn&apos;t found—over 3,000 older companies and physical share certificates require an archival RTA trace.&rdquo;
              </p>
            </div>

            <p className="max-w-[75ch] text-sm text-fg-2">
              Physical share certificates, name variations, old address discrepancies, or legacy shares held in company suspense accounts often do not appear in basic online registries. Our specialist recovery research desk can initiate an archival registry investigation at zero upfront cost.
            </p>

            {data.liveRefreshId && <LiveRefresh id={data.liveRefreshId} />}

            <div className="w-full mt-2 pt-4 border-t border-border">
              <DeeperTrace
                key={`${name}:${state}`}
                holderName={name}
                scope={state}
                signedIn={data.access !== "public"}
              />
            </div>
          </div>
        )}

        {data && data.total > 0 && (
          <>
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <h2 className="text-xl font-semibold text-fg">
                <span className="tnum">{data.total}</span>
                {data.truncated ? "+" : ""} {data.total === 1 ? "record" : "records"} for {who} in{" "}
                {where}
              </h2>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {data.liveRefreshId && <LiveRefresh id={data.liveRefreshId} />}
                <p className="text-sm text-fg-3 tnum">Checked in {data.tookMs} ms</p>
              </div>
            </div>
            {data.truncated && (
              <Alert variant="pending" className="mb-5" role="status">
                <InfoIcon aria-hidden="true" />
                <AlertDescription>
                  Showing the first {data.limit} records; more matched. Add a first name or choose a
                  state to narrow the search.
                </AlertDescription>
              </Alert>
            )}
            <SearchResults results={data.results} access={data.access} referralCode={ref} />
            {data.access !== "public" && (
              <Alert variant="info" className="mt-8">
                <InfoIcon aria-hidden="true" />
                <AlertTitle>How the estimate is worked out</AlertTitle>
                <AlertDescription>{data.valuationBasis}</AlertDescription>
              </Alert>
            )}
          </>
        )}

        {data && <CoveragePanel coverage={data.coverage} className="mt-8" />}
        {!data && !asked && (
          <p className="mt-2 max-w-[70ch] text-sm text-fg-3">{COVERAGE_DISCLAIMER}</p>
        )}
      </section>
    </div>
  );
}
