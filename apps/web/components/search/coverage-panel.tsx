import { DatabaseIcon } from "lucide-react";
import { COVERAGE_DISCLAIMER, type SearchCoverage } from "@finsol/shared";

import { formatCount, formatDate, statementYears } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A source older than this (by its newest record) is called out as old. */
const OLD_AFTER_YEARS = 3;

/**
 * What the search covers, beside every result list and every "no match".
 * Holder records, company profiles and listed equities are different things
 * and are never added together.
 */
export function CoveragePanel({
  coverage,
  className,
}: {
  coverage: SearchCoverage;
  className?: string;
}) {
  const companies = coverage.companiesWithRecords;
  const thisYear = new Date().getFullYear();
  const old =
    coverage.newestRecordYear !== null && thisYear - coverage.newestRecordYear > OLD_AFTER_YEARS;
  return (
    <aside
      aria-labelledby="coverage-heading"
      className={cn("panel p-5 text-sm sm:p-6", className)}
      data-testid="coverage-panel"
    >
      <h2 id="coverage-heading" className="flex items-center gap-2 text-base font-semibold text-fg">
        <DatabaseIcon className="size-4 text-signal" aria-hidden="true" />
        What this search covers
      </h2>
      <p className="mt-2 max-w-[75ch] text-fg-2">{COVERAGE_DISCLAIMER}</p>
      <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="text-fg-3">Unclaimed-holder records searchable</dt>
          <dd className="text-fg tnum">
            {formatCount(coverage.holderRecords)}{" "}
            <span className="text-fg-3">(statement entries, not people)</span>
          </dd>
        </div>
        <div>
          <dt className="text-fg-3">Companies with holder records</dt>
          <dd className="text-fg">
            {coverage.companiesWithRecordsCount === 0
              ? "None yet"
              : companies.length
                ? companies.map((c) => `${c.name} (${formatCount(c.records)})`).join(", ")
                : `${formatCount(coverage.companiesWithRecordsCount)} (names shown after sign-in)`}
          </dd>
        </div>
        <div>
          <dt className="text-fg-3">Statement period covered</dt>
          <dd className="text-fg tnum">
            {statementYears(
              coverage.oldestRecordYear,
              coverage.newestRecordYear,
              coverage.latestSourcePublishedAt,
            )}
            {old && (
              <span className="ml-1 text-pending">
                (older statements; newer ones are not imported yet)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-fg-3">Source freshness</dt>
          <dd className="text-fg">
            {coverage.latestSourceRetrievedAt
              ? `Statements last retrieved ${formatDate(coverage.latestSourceRetrievedAt)}${
                  coverage.latestSourcePublishedAt
                    ? `; latest published ${formatDate(coverage.latestSourcePublishedAt)}`
                    : ""
                }`
              : "Retrieval dates are being recorded; imports before November 2026 did not keep them."}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-fg-3">
        Not counted here: {formatCount(coverage.companyProfiles)} company profiles and{" "}
        {formatCount(coverage.listedEquities)} listed equities used by the calculator. They hold no
        shareholder data.
      </p>
    </aside>
  );
}
