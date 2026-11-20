import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRightIcon, CalculatorIcon, SearchIcon, TrendingUpIcon } from "lucide-react";
import {
  BRAND,
  describeQuote,
  computeEntitlement,
  CUSTODY_LABELS,
  holdingValuePaise,
  PUBLIC_PRICING,
  SERVICE_STEPS,
} from "@finsol/shared";

import { Button } from "@/components/ui/button";
import { JsonLd } from "@/components/seo/json-ld";
import { getCompany, listCompanies } from "@/lib/companies";
import { exampleYearFor } from "@/lib/calculator";
import { companyDisplayName, formatCount, formatDate, formatPaise } from "@/lib/format";
import { CHECK_CTA } from "@/components/site/cta";
import { SITE_URL } from "@/lib/site";
import { cn } from "@/lib/utils";

// Matches the API's 15-minute price sync.
export const revalidate = 900;

export async function generateStaticParams() {
  return (await listCompanies()).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const c = await getCompany((await params).slug);
  if (!c) return {};
  const name = companyDisplayName(c.name);
  return {
    title: `Recover unclaimed ${name} shares and dividends`,
    description: `Unclaimed ${name} shares recovered end to end by Finsol Enterprises: bonus and split history, the latest available share price and a free 3-Minute Check. No upfront fee.`,
    alternates: { canonical: `/unclaimed-shares/${c.slug}` },
  };
}

const EXAMPLE_SHARES = 100;

/** Exchange feeds label every bonus and split row "split history"; bonuses say what they are. */
function sourceText(a: { actionType: string; source: string | null }) {
  if (!a.source || a.actionType !== "BONUS") return a.source;
  return a.source.replace(/split history/i, "corporate-action record");
}

function ratioText(a: {
  actionType: string;
  ratioFrom: number | null;
  ratioTo: number | null;
  dividendPerShare: number | null;
}) {
  if (a.actionType === "CASH_ENTITLEMENT") return `₹${a.dividendPerShare} cash per equity share`;
  if (a.ratioFrom === null || a.ratioTo === null) return "";
  if (a.actionType === "SPLIT") return `Face value ₹${a.ratioFrom} to ₹${a.ratioTo}`;
  return `${a.ratioTo} new for every ${a.ratioFrom} held`;
}

const ACTION_LABEL: Record<string, string> = {
  BONUS: "Bonus issue",
  SPLIT: "Stock split",
  MERGER: "Merger",
  CASH_ENTITLEMENT: "Cash entitlement",
};

export default async function CompanyGuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const raw = await getCompany(slug);
  if (!raw) notFound();
  const c = { ...raw, name: companyDisplayName(raw.name) };

  const { year: EXAMPLE_YEAR, fromRecords: exampleFromRecords } = exampleYearFor(
    raw.corporateActions,
  );
  const structural = c.corporateActions.filter((a) => a.actionType !== "DIVIDEND");
  const dividends = c.corporateActions
    .filter((a) => a.actionType === "DIVIDEND")
    .slice(-7)
    .reverse();
  const dividendSource = dividends[0]?.source;
  const example = computeEntitlement(
    EXAMPLE_SHARES,
    c.corporateActions.map((a) => ({ ...a })),
    { acquiredOn: `${EXAMPLE_YEAR}-01-01` },
  );
  const price = c.currentMarketPrice;
  const exampleValue = price !== null ? holdingValuePaise(example.shares, price) : null;
  const totalRecords = c.records.reduce((n, r) => n + r.folios, 0);
  const quote = describeQuote({
    price,
    quoteAt: c.priceQuoteAt ?? null,
    retrievedAt: c.priceUpdatedAt,
    attemptedAt: c.priceAttemptedAt ?? null,
    error: c.priceError ?? null,
    source: c.priceSource,
  });

  return (
    <article className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6 sm:py-16">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Service",
          name: `Recovery of unclaimed ${c.name} shares and dividends`,
          provider: { "@type": "Organization", name: BRAND.name, url: SITE_URL },
          areaServed: "IN",
        }}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Companies",
              item: `${SITE_URL}/unclaimed-shares`,
            },
            {
              "@type": "ListItem",
              position: 2,
              name: c.name,
              item: `${SITE_URL}/unclaimed-shares/${c.slug}`,
            },
          ],
        }}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-fg-3">
        <Link href="/unclaimed-shares" className="link text-fg-2">
          Companies
        </Link>{" "}
        / {c.name}
      </nav>
      <h1 className="display mt-4 max-w-[22ch] text-[clamp(2rem,4.4vw,3.25rem)] text-fg">
        Recover unclaimed {c.name} shares and dividends
      </h1>
      <p className="mt-4 max-w-[62ch] text-lg text-fg-2">
        If dividends on {c.name} shares went unclaimed for years, the shares may have moved out of
        the family&apos;s reach. They are still recoverable by the holder or their heirs, and{" "}
        {BRAND.name} handles the whole recovery for you.
      </p>
      <p className="mt-3 text-base font-medium text-signal">{BRAND.promise.join(" • ")}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/search">
            <SearchIcon aria-hidden="true" />
            {CHECK_CTA}
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href={`/calculator?company=${c.slug}`}>
            <CalculatorIcon aria-hidden="true" />
            What are old shares worth today?
          </Link>
        </Button>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-10">
          <section aria-labelledby="example-heading" className="panel p-5 sm:p-6">
            <h2 id="example-heading" className="text-xl font-semibold text-fg">
              {EXAMPLE_SHARES} shares bought in {EXAMPLE_YEAR}, today
            </h2>
            <p className="mt-3 text-fg-2">
              After the bonuses and splits below, {formatCount(EXAMPLE_SHARES)} shares held since{" "}
              {EXAMPLE_YEAR}
              {exampleFromRecords ? ", the earliest year in our records," : ""} would now be{" "}
              <strong className="text-fg tnum">{formatCount(example.shares)} shares</strong>
              {exampleValue !== null ? (
                <>
                  , worth about{" "}
                  <strong className="text-fg tnum">{formatPaise(exampleValue)}</strong> at
                  today&apos;s price
                </>
              ) : null}
              {example.cashPaise > 0 && (
                <>
                  , plus <strong className="text-fg tnum">{formatPaise(example.cashPaise)}</strong>{" "}
                  in cash entitlements
                </>
              )}
              . Our analysts confirm the exact figure during verification.
            </p>
          </section>

          <section aria-labelledby="actions-heading">
            <h2 id="actions-heading" className="text-xl font-semibold text-fg">
              Bonus, split and cash history
            </h2>
            {structural.length === 0 ? (
              <p className="mt-3 text-fg-2">{c.name} has made no bonus issue or share split.</p>
            ) : (
              <div
                className="panel mt-4 overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-labelledby="actions-heading"
              >
                <table className="w-full min-w-[36rem] text-left">
                  <thead className="text-sm text-fg-3">
                    <tr className="border-b border-(--glass-border)">
                      <th scope="col" className="px-4 py-3 font-medium">
                        Ex-date
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Action
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Terms
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Source
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-(--glass-border)">
                    {structural.map((a) => (
                      <tr key={`${a.actionType}-${a.exDate}`} className="align-top">
                        <td className="px-4 py-3 whitespace-nowrap text-fg-2 tnum">
                          {formatDate(a.exDate)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-fg">
                          {ACTION_LABEL[a.actionType] ?? a.actionType}
                        </td>
                        <td className="px-4 py-3 text-fg-2">
                          {ratioText(a)}
                          {a.notes && a.actionType !== "BONUS" && a.notes !== ratioText(a) && (
                            <span className="mt-1 block text-sm text-fg-3">{a.notes}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-fg-3">{sourceText(a)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {dividends.length > 0 && (
              <p className="mt-4 text-sm text-fg-2">
                Recent dividends per share:{" "}
                {dividends.map((d, i) => (
                  <span key={d.exDate} className="tnum">
                    {i > 0 ? ", " : ""}₹{d.dividendPerShare} ({formatDate(d.exDate)})
                  </span>
                ))}
                .
                {dividendSource ? (
                  <span className="text-fg-3"> Source: {dividendSource}.</span>
                ) : null}
              </p>
            )}
          </section>

          <section aria-labelledby="steps-heading">
            <h2 id="steps-heading" className="text-xl font-semibold text-fg">
              How {BRAND.name} recovers {c.name} shares for you
            </h2>
            <ol className="mt-5 grid gap-5">
              {SERVICE_STEPS.map((s) => (
                <li key={s.step} className="grid grid-cols-[2.5rem_1fr] gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full border border-signal/40 bg-signal/10 font-semibold text-signal tnum">
                    {s.step}
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-fg">{s.title}</h3>
                    <p className="mt-1 text-fg-2">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-fg-2">
              <strong className="text-fg">{PUBLIC_PRICING.headline}:</strong>{" "}
              {PUBLIC_PRICING.detail}
            </p>
          </section>
        </div>

        <aside className="grid min-w-0 grid-cols-1 content-start gap-6">
          <section aria-labelledby="price-heading" className="panel p-5 sm:p-6">
            <h2
              id="price-heading"
              className="flex items-center gap-2 text-lg font-semibold text-fg"
            >
              <TrendingUpIcon className="size-5 text-signal" aria-hidden="true" />
              Share price
            </h2>
            {price !== null ? (
              <>
                <p className="mt-2 text-3xl font-semibold text-fg tnum [font-stretch:104%]">
                  {formatPaise(Math.round(price * 100), { exact: true })}
                </p>
                <p className="mt-1 text-sm font-medium text-fg-2">{quote.label}</p>
                <p className="mt-1 text-sm text-fg-3">{quote.detail}</p>
              </>
            ) : (
              <p className="mt-2 text-sm text-fg-2">
                {quote.label}. {quote.detail}
              </p>
            )}
          </section>

          <section aria-labelledby="facts-heading" className="panel p-5 sm:p-6">
            <h2 id="facts-heading" className="text-lg font-semibold text-fg">
              {c.name}
            </h2>
            <dl className="mt-3 grid gap-2 text-sm">
              {(
                [
                  ["Sector", c.sector],
                  ["NSE", c.tickerNse],
                  ["BSE", c.tickerBse],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4">
                    <dt className="text-fg-3">{k}</dt>
                    <dd
                      className={cn(
                        "text-right break-words text-fg",
                        k === "Sector" ? "" : "font-mono tnum",
                      )}
                    >
                      {v}
                    </dd>
                  </div>
                ))}
            </dl>
          </section>

          <section aria-labelledby="records-heading" className="panel p-5 sm:p-6">
            <h2 id="records-heading" className="text-lg font-semibold text-fg">
              {c.name} holder records we hold
            </h2>
            {totalRecords > 0 ? (
              <>
                <ul className="mt-3 grid gap-2 text-sm">
                  {c.records.map((r) => (
                    <li key={r.custodyStatus} className="flex justify-between gap-4">
                      <span className="text-fg-2">
                        {r.shares > 0
                          ? CUSTODY_LABELS[r.custodyStatus]
                          : "Unclaimed dividend listings (no share count stated)"}
                      </span>
                      <span className="text-fg tnum">{formatCount(r.folios)} records</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-sm text-fg-3">
                  Records from statements {c.name} published. One person can appear in several
                  records; this is not a count of people.
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-fg-2">
                We have not imported any {c.name} holder statements yet. That does not mean there
                are no unclaimed holdings: ask us for a free trace.
              </p>
            )}
            <Button asChild variant="outline" size="sm" className="mt-4">
              <Link href="/search">
                Check your family&apos;s name
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </section>
        </aside>
      </div>
    </article>
  );
}
