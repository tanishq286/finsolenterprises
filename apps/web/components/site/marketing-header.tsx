import Link from "next/link";

import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { CHECK_CTA } from "@/components/site/cta";
import { NavLinks } from "@/components/site/nav-links";
import { AccountLink } from "@/components/auth/account-link";

const NAV = [
  { href: "/search", label: "3-Minute Check" },
  { href: "/services", label: "Services" },
  { href: "/calculator", label: "Calculator" },
  { href: "/unclaimed-shares", label: "Companies" },
  { href: "/partners", label: "Partners" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#contact", label: "Contact" },
];

export function MarketingHeader() {
  return (
    <header
      style={{ viewTransitionName: "site-header" }}
      className="chrome relative top-0 z-(--z-chrome) border-b border-(--glass-border) lg:sticky"
    >
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-8 gap-y-1 px-4 py-2.5 sm:px-6 lg:flex-nowrap">
        <Wordmark />
        <div className="order-3 w-full lg:order-2 lg:w-auto">
          <NavLinks items={NAV} label="Main" />
        </div>
        <div className="order-2 flex items-center gap-3 lg:order-3">
          <AccountLink />
          <Button
            asChild
            size="sm"
            className="hidden whitespace-nowrap sm:inline-flex lg:hidden 2xl:inline-flex"
          >
            <Link href="/search">{CHECK_CTA}</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
