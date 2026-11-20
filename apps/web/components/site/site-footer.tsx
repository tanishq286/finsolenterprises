import Link from "next/link";
import { MailIcon } from "lucide-react";
import { BRAND, BRAND_DESKS } from "@finsol/shared";

import { Wordmark } from "@/components/brand/wordmark";
import { cn } from "@/lib/utils";

const LINK_GROUPS: { title: string; links: [href: string, label: string][] }[] = [
  {
    title: "Check & recover",
    links: [
      ["/search", "3-Minute Check"],
      ["/deeper-trace", "Deeper Trace"],
      ["/calculator", "Calculator"],
      ["/services", "Services"],
    ],
  },
  {
    title: "Company",
    links: [
      ["/unclaimed-shares", "Companies"],
      ["/partners", "Partners"],
      ["/#pricing", "Pricing"],
      ["/login", "Client login"],
    ],
  },
  {
    title: "Legal",
    links: [
      ["/privacy", "Privacy"],
      ["/terms", "Terms"],
    ],
  },
];

/** The general desk; the full list of desks lives in the contact section and the pages that need it. */
const SUPPORT = BRAND_DESKS.find((d) => d.key === "support") ?? BRAND_DESKS[0]!;

/** `wide` matches the app shell's container (84rem); the default matches marketing pages. */
export function SiteFooter({ wide = false }: { wide?: boolean }) {
  const width = wide ? "max-w-[84rem]" : "max-w-[1200px]";
  return (
    <footer className="mt-auto border-t border-(--glass-border) bg-ink-950/60">
      <div
        className={cn(
          "mx-auto grid gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.25fr_2fr] lg:gap-16",
          width,
        )}
      >
        <div className="space-y-4">
          <Wordmark />
          <p className="text-sm font-medium text-signal">{BRAND.promise.join(" • ")}</p>
          <p className="max-w-sm text-sm text-fg-3">
            An independent recovery firm, not a government body. We do not give legal, tax or
            investment advice.
          </p>
          <a
            href={`mailto:${SUPPORT.email}`}
            className="link inline-flex items-center gap-1.5 text-sm break-all text-fg-2"
          >
            <MailIcon className="size-3.5 shrink-0" aria-hidden="true" />
            {SUPPORT.email}
          </a>
          <p className="max-w-sm text-sm text-fg-2">
            <span className="font-medium text-fg">If something feels wrong:</span> we never ask for
            a fee upfront or for any code over the phone. Report fraud at{" "}
            <a
              href="https://cybercrime.gov.in"
              rel="noopener noreferrer"
              target="_blank"
              className="link"
            >
              cybercrime.gov.in<span className="sr-only"> (opens in a new tab)</span>
            </a>{" "}
            or call <span className="tnum font-semibold text-fg">1930</span>.
          </p>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {LINK_GROUPS.map((g) => (
            <div key={g.title}>
              <h2 className="text-sm font-medium tracking-normal text-fg [font-stretch:100%]">
                {g.title}
              </h2>
              <ul className="mt-4 space-y-2.5 text-sm">
                {g.links.map(([href, label]) => (
                  <li key={href}>
                    <Link href={href} className="link text-fg-2">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="border-t border-(--glass-border)">
        <p className={cn("mx-auto px-4 py-5 text-sm text-fg-3 sm:px-6", width)}>
          © {new Date().getFullYear()} {BRAND.name} · {BRAND.domain}
        </p>
      </div>
    </footer>
  );
}
