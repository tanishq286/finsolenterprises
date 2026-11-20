import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import {
  ArrowRightIcon,
  BadgeCheckIcon,
  HandshakeIcon,
  MapPinIcon,
  PercentIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { BRAND_EMAILS, isIndianState, STATE_LABELS, type IndianState } from "@finsol/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StateOptions } from "@/components/search/state-options";
import { apiOrNull } from "@/lib/api/server";
import type { LocatorEntry } from "@/lib/api/types";

export const metadata: Metadata = {
  title: "Partners: CAs, CSs, advocates and advisors",
  description:
    "Refer clients with unclaimed shares and earn 30% of our fee on every recovery. Or find a verified partner near you by state and city.",
  alternates: { canonical: "/partners" },
};

const POINTS = [
  {
    Icon: PercentIcon,
    title: "30% of our fee",
    body: "On every referred case, accrued when the client's shares are credited and paid to your bank account.",
  },
  {
    Icon: HandshakeIcon,
    title: "Your client stays yours",
    body: "You see every case move from check to credit. Finsol does the filing, the chasing and the paperwork.",
  },
  {
    Icon: ShieldCheckIcon,
    title: "No upfront fees, ever",
    body: "Your clients pay nothing unless value is credited, so you can recommend us without risk to them.",
  },
];

export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; city?: string }>;
}) {
  const p = await searchParams;
  const state: IndianState | "" = isIndianState(p.state) ? p.state : "";
  const city = p.city?.trim() ?? "";
  const qs = new URLSearchParams();
  if (state) qs.set("state", state);
  if (city) qs.set("city", city);
  const partners = await apiOrNull<LocatorEntry[]>(`associates/locator${qs.size ? `?${qs}` : ""}`, {
    revalidate: 300,
  });
  // A filtered search that finds nobody: are there any verified partners at all?
  const anyListed =
    partners === null
      ? null
      : partners.length > 0
        ? true
        : qs.size === 0
          ? false
          : ((await apiOrNull<LocatorEntry[]>("associates/locator", { revalidate: 300 }))?.length ??
              0) > 0;
  // With no verified partners anywhere, a State/City filter is a dead end: offer joining instead.
  const noneListed = anyListed === false;

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="display max-w-[20ch] text-[clamp(2rem,4vw,3rem)] text-fg">
        Partner with Finsol Enterprises
      </h1>
      <p className="mt-4 max-w-[62ch] text-lg text-fg-2">
        Chartered accountants, company secretaries, advocates, wealth advisors and former bankers
        meet families with old certificates every week. Refer them here and earn on every recovery.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/partners/join">
            Become a partner
            <ArrowRightIcon aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/login?next=/partners/dashboard">Partner sign in</Link>
        </Button>
      </div>
      <p className="mt-4 text-sm text-fg-2">
        Partner / Associate Desk:{" "}
        <a href={`mailto:${BRAND_EMAILS.partners}`} className="link">
          {BRAND_EMAILS.partners}
        </a>
      </p>

      <ul className="mt-14 grid gap-4 md:grid-cols-3">
        {POINTS.map(({ Icon, title, body }) => (
          <li key={title} className="panel p-5">
            <Icon className="size-6 text-signal" aria-hidden="true" />
            <h2 className="mt-3 text-lg font-semibold text-fg">{title}</h2>
            <p className="mt-1 text-fg-2">{body}</p>
          </li>
        ))}
      </ul>

      <section id="locator" aria-labelledby="locator-heading" className="mt-20 scroll-mt-24">
        <h2 id="locator-heading" className="text-[clamp(1.5rem,2.6vw,2rem)] font-semibold text-fg">
          Find a partner near you
        </h2>
        <p className="mt-2 max-w-[60ch] text-fg-2">
          Only partners whose professional details we have checked are listed.
        </p>
        {!noneListed && (
          <Form
            action="/partners"
            className="mt-6 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          >
            <div>
              <label htmlFor="p-state" className="mb-1.5 block text-sm text-fg-3">
                State
              </label>
              <Select id="p-state" name="state" defaultValue={state}>
                <StateOptions placeholder="Any state" />
              </Select>
            </div>
            <div>
              <label htmlFor="p-city" className="mb-1.5 block text-sm text-fg-3">
                City
              </label>
              <Input
                id="p-city"
                name="city"
                defaultValue={city}
                placeholder="Any city"
                maxLength={80}
              />
            </div>
            <Button type="submit" variant="outline" className="min-h-12">
              <MapPinIcon aria-hidden="true" />
              Show partners
            </Button>
          </Form>
        )}

        {partners === null ? (
          <p className="mt-6 text-fg-3">The partner directory is not available right now.</p>
        ) : noneListed ? (
          <div
            className="panel mt-6 flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
            role="status"
            data-testid="partners-empty-global"
          >
            <div>
              <p className="text-lg font-semibold text-fg">No verified partners are listed yet</p>
              <p className="mt-1 max-w-[60ch] text-fg-2">
                Are you a CA, CS, advocate or advisor? Apply to be the first listed partner in your
                city. Families can still{" "}
                <Link href="/search" className="link">
                  check for unclaimed holdings
                </Link>{" "}
                directly.
              </p>
            </div>
            <Button asChild className="shrink-0 whitespace-nowrap">
              <Link href="/partners/join">
                Apply to become a partner
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        ) : partners.length === 0 ? (
          <p className="mt-6 text-fg-2" role="status" data-testid="partners-empty-filtered">
            No verified partners{" "}
            {city && state
              ? `in ${city}, ${STATE_LABELS[state]}`
              : city
                ? `in ${city}`
                : `in ${STATE_LABELS[state as IndianState]}`}
            .{" "}
            <Link href="/partners" className="link">
              Clear the filter
            </Link>{" "}
            to see every listed partner, or search for your holding directly.
          </p>
        ) : (
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {partners.map((a) => (
              <li key={a.id} className="panel flex h-full flex-col gap-2 p-5">
                <p className="flex items-center gap-1.5 text-lg font-semibold text-fg">
                  {a.name}
                  <BadgeCheckIcon className="size-4 text-confirmed" aria-label="Verified partner" />
                </p>
                <p className="text-fg-2">{a.firmName}</p>
                <p className="text-sm text-fg-3">
                  {a.professionLabel} · {a.city}, {a.stateLabel}
                </p>
                {a.bio && <p className="text-sm text-fg-2">{a.bio}</p>}
                <Button asChild variant="ghost" size="sm" className="mt-auto justify-self-start">
                  <Link href={`/search?ref=${a.referralCode}`}>
                    Search with {a.name.split(" ")[0]}
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
