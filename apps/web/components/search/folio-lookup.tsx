"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  CircleCheckIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LockIcon,
  SearchIcon,
  SearchXIcon,
} from "lucide-react";
import { COMPANY_QUERY_MAX, type FolioSearchResponse } from "@finsol/shared";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoginGatewayDialog } from "@/components/auth/login-gateway-dialog";
import { SearchResults } from "@/components/search/search-results";
import { callApi } from "@/lib/api/client";

/**
 * Company + folio lookup, for people holding a certificate. It runs as a
 * background request only: the folio number never enters the page URL or
 * the browser history. The public learns only whether a record exists; who
 * it belongs to opens after sign-in.
 */
export function FolioLookup() {
  const [company, setCompany] = React.useState("");
  const [folio, setFolio] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<FolioSearchResponse | null>(null);
  const [checkedCompany, setCheckedCompany] = React.useState("");
  const [gatewayOpen, setGatewayOpen] = React.useState(false);

  async function lookUp() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const qs = new URLSearchParams({ company: company.trim(), folio: folio.trim() });
      setResult(await callApi<FolioSearchResponse>(`search/folio?${qs}`));
      setCheckedCompany(company.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Only non-sensitive fields go into the Deeper Trace link: never the folio.
  const traceHref = `/deeper-trace?${new URLSearchParams({ company: checkedCompany })}`;

  return (
    <div className="grid gap-5">
      <form
        aria-label="Look up a company and folio number"
        className="vault-glass relative rounded-[20px] p-4 sm:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void lookUp();
        }}
      >
        <div className="@container">
          <div className="grid gap-3 @[34rem]:grid-cols-2">
            <div>
              <label htmlFor="f-company" className="mb-1.5 block text-sm text-fg-2">
                Company name *
              </label>
              <Input
                id="f-company"
                required
                maxLength={COMPANY_QUERY_MAX}
                autoComplete="off"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Dabur India"
              />
            </div>
            <div>
              <label htmlFor="f-folio" className="mb-1.5 block text-sm text-fg-2">
                Folio number *
              </label>
              <Input
                id="f-folio"
                required
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                value={folio}
                onChange={(e) => setFolio(e.target.value)}
                placeholder="As printed on the certificate"
                className="tnum"
              />
            </div>
          </div>
          <Button
            type="submit"
            size="lg"
            disabled={busy}
            aria-busy={busy}
            className="mt-3 min-h-12 w-full @[34rem]:w-auto"
          >
            {busy ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <SearchIcon aria-hidden="true" />
            )}
            {busy ? "Checking…" : "Check this folio"}
          </Button>
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-sm text-fg-3">
          <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          An exact match on the folio printed on the certificate. Who a record belongs to is shown
          only after a free sign-in.
        </p>
      </form>

      <div aria-live="polite">
        {error && (
          <Alert variant="pending" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && result.found > 0 && result.access === "public" && (
          <div className="panel flex flex-col gap-4 p-5 sm:p-6" data-testid="folio-match">
            <p className="flex items-center gap-2 text-lg font-semibold text-fg">
              <CircleCheckIcon className="size-5 shrink-0 text-confirmed" aria-hidden="true" />A
              record matches this company and folio
            </p>
            <p className="text-fg-2">
              Sign in free to see whose name it is in and what it holds, or ask an analyst to trace
              it for you. Nothing is payable upfront.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button className="whitespace-nowrap" onClick={() => setGatewayOpen(true)}>
                <KeyRoundIcon aria-hidden="true" />
                Sign in to see the record
              </Button>
              <Button asChild variant="outline" className="whitespace-nowrap">
                <Link href={traceHref}>
                  Request a Deeper Trace
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
        )}

        {result && result.found > 0 && result.access !== "public" && (
          <SearchResults results={result.results} access={result.access} />
        )}

        {result && result.found === 0 && (
          <div className="panel flex flex-col gap-4 p-5 sm:p-6" data-testid="folio-no-match">
            <p className="flex items-center gap-2 text-lg font-semibold text-fg">
              <SearchXIcon className="size-5 shrink-0 text-fg-3" aria-hidden="true" />
              No record for this folio in our index
            </p>
            <p className="text-fg-2">
              {result.companyMatched
                ? "We hold statements for this company, but none lists this folio. Older years, physical certificates and suspense-account shares are often missing from published lists."
                : "We do not hold statements for this company yet. Many companies and years are not in our index."}{" "}
              An analyst can look further, at no upfront cost.
            </p>
            <Button asChild variant="outline" className="w-fit whitespace-nowrap">
              <Link href={traceHref}>
                Request a Deeper Trace
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        )}
      </div>

      <LoginGatewayDialog
        open={gatewayOpen}
        onOpenChange={setGatewayOpen}
        reason="to see who this record belongs to"
        onSignedIn={() => void lookUp()}
      />
    </div>
  );
}
