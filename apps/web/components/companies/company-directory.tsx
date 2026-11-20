"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRightIcon, SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { letterSections } from "@/lib/directory";
import { companyDisplayName } from "@/lib/format";

export interface DirectoryCompany {
  slug: string;
  name: string;
  sector: string | null;
  tickerNse: string | null;
  folioCount: number;
}

const ALPHABET = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

export function CompanyDirectory({ companies }: { companies: DirectoryCompany[] }) {
  const [q, setQ] = React.useState("");
  const all = React.useMemo(
    () =>
      companies
        .map((c) => ({ ...c, name: companyDisplayName(c.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, "en-IN")),
    [companies],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? all.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          (c.tickerNse ?? "").toLowerCase().includes(needle) ||
          (c.sector ?? "").toLowerCase().includes(needle),
      )
    : all;
  const sections = letterSections(shown);
  // Every letter in a merged section jumps to that section, anchored on its first letter.
  const anchorFor = new Map(
    sections.flatMap((s) => s.letters.map((l) => [l, s.letters[0]!] as const)),
  );

  return (
    <div className="grid gap-8">
      <div className="grid gap-4">
        <div className="relative max-w-md">
          <label htmlFor="dir-filter" className="sr-only">
            Filter companies
          </label>
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3"
            aria-hidden="true"
          />
          <Input
            id="dir-filter"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by company, NSE symbol or sector"
            autoComplete="off"
            className="pl-9"
          />
        </div>
        <nav aria-label="Jump to letter">
          <ul className="flex flex-wrap gap-1">
            {ALPHABET.map((l) => {
              const target = anchorFor.get(l);
              return (
                <li key={l}>
                  {target ? (
                    <a
                      href={`#letter-${target}`}
                      className="flex size-9 items-center justify-center rounded-[8px] text-sm font-medium text-fg-2 hover:bg-signal-wash hover:text-fg focus-visible:outline-2 focus-visible:outline-signal"
                    >
                      {l}
                    </a>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-9 items-center justify-center text-sm text-fg-3/50"
                    >
                      {l}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="text-sm text-fg-3" role="status">
          {needle
            ? `${shown.length} of ${all.length} companies match “${q.trim()}”.`
            : `${all.length} companies.`}
        </p>
      </div>

      {sections.length === 0 ? (
        <p className="panel p-5 text-fg-2">
          No company matches that filter. Try fewer letters, or start the 3-Minute Check with the
          investor&apos;s name above.
        </p>
      ) : (
        sections.map((s) => (
          <section
            key={s.label}
            id={`letter-${s.letters[0]}`}
            aria-labelledby={`letter-h-${s.letters[0]}`}
            className="scroll-mt-24"
          >
            <h2 id={`letter-h-${s.letters[0]}`} className="text-sm font-semibold text-fg-3">
              {s.label}
            </h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.items.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/unclaimed-shares/${c.slug}`}
                    className="panel vault-glass-hover group flex h-full flex-col gap-1.5 p-4 focus-visible:outline-2 focus-visible:outline-signal"
                  >
                    <span className="flex items-start justify-between gap-2 font-semibold text-fg">
                      {c.name}
                      <ArrowRightIcon
                        className="mt-1 size-4 shrink-0 text-fg-3 transition-transform duration-150 group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </span>
                    <span className="text-sm text-fg-2">
                      {c.sector ?? "Listed company"}
                      {c.tickerNse ? ` · NSE: ${c.tickerNse}` : ""}
                    </span>
                    <span className="mt-auto pt-1">
                      <StatusBadge tone={c.folioCount > 0 ? "success" : "neutral"} live={false}>
                        {c.folioCount > 0 ? "Holder records imported" : "Company profile"}
                      </StatusBadge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
