import type { Metadata } from "next";

import { CompanyDirectory } from "@/components/companies/company-directory";
import { UnclaimedSearchForm } from "@/components/search/unclaimed-search-form";
import { listCompanies } from "@/lib/companies";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Unclaimed shares by company",
  description:
    "Unclaimed shares and dividends recovered company by company by Finsol Enterprises: bonus and split history, the latest available prices and a free 3-Minute Check.",
  alternates: { canonical: "/unclaimed-shares" },
};

export default async function CompanyIndexPage() {
  const companies = await listCompanies();
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="display max-w-[22ch] text-[clamp(2rem,4vw,3rem)] text-fg">
        Unclaimed shares, company by company
      </h1>
      <p className="mt-4 max-w-[62ch] text-lg text-fg-2">
        How bonuses and splits have grown an old holding, and what it is worth today. Pick a
        company, or start the 3-Minute Check with the investor&apos;s name.
      </p>
      <UnclaimedSearchForm className="mt-8 max-w-[56rem]" compact />
      <div className="mt-14">
        <CompanyDirectory
          companies={companies.map(({ slug, name, sector, tickerNse, folioCount }) => ({
            slug,
            name,
            sector,
            tickerNse,
            folioCount,
          }))}
        />
      </div>
    </div>
  );
}
