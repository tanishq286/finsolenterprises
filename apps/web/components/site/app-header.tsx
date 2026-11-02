import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { NavLinks, type NavItem } from "@/components/site/nav-links";
import { AccountLink } from "@/components/auth/account-link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { getViewer, isStaffRole } from "@/lib/api/server";

const PUBLIC_NAV: NavItem[] = [
  { href: "/search", label: "3-Minute Check" },
  { href: "/calculator", label: "Calculator" },
];

export async function AppHeader() {
  const viewer = await getViewer();
  const nav: NavItem[] = !viewer
    ? PUBLIC_NAV
    : isStaffRole(viewer.role)
      ? [
          { href: "/admin/crm", label: "CRM board" },
          { href: "/admin/traces", label: "Trace requests" },
          { href: "/portal", label: "Cases" },
          { href: "/admin/companies", label: "Company files" },
          ...(viewer.role === "VALUATION_ANALYST"
            ? []
            : [
                { href: "/admin/ingestion", label: "Imports" },
                { href: "/admin/coverage", label: "Coverage" },
              ]),
          { href: "/search", label: "Search" },
        ]
      : viewer.role === "ASSOCIATE_PARTNER"
        ? [
            { href: "/partners/dashboard", label: "Partner desk" },
            { href: "/portal", label: "Referred cases" },
            { href: "/search", label: "Search" },
          ]
        : [
            { href: "/portal", label: "My cases" },
            { href: "/traces", label: "My traces" },
            { href: "/search", label: "3-Minute Check" },
            { href: "/calculator", label: "Calculator" },
          ];
  return (
    <header
      style={{ viewTransitionName: "site-header" }}
      className="chrome relative top-0 z-(--z-chrome) border-b border-(--glass-border) lg:sticky"
    >
      <div className="mx-auto flex max-w-[84rem] flex-wrap items-center justify-between gap-x-6 px-4 py-1.5 sm:px-6">
        <Wordmark />
        {/* Phones: utilities share the logo row, navigation gets its own row. */}
        <div className="order-3 -mt-1 w-full sm:order-2 sm:mt-0 sm:ml-auto sm:w-auto">
          <NavLinks items={nav} label="App" />
        </div>
        <div className="order-2 flex items-center gap-2 sm:order-3">
          <ThemeToggle />
          {viewer ? <SignOutButton /> : <AccountLink />}
        </div>
      </div>
    </header>
  );
}
