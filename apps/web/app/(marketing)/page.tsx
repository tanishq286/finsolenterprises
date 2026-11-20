import Link from "next/link";
import {
  ArrowRightIcon,
  BadgeIndianRupeeIcon,
  BanIcon,
  BriefcaseBusinessIcon,
  CalculatorIcon,
  FileSignatureIcon,
  HandshakeIcon,
  LandmarkIcon,
  LockKeyholeIcon,
  MailIcon,
  SearchCheckIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { BRAND, BRAND_DESKS, PUBLIC_PRICING, SERVICE_STEPS } from "@finsol/shared";

import { Button } from "@/components/ui/button";
import { VaultCard } from "@/components/ui/vault-card";
import { UnclaimedSearchForm } from "@/components/search/unclaimed-search-form";
import { LiveCounters } from "@/components/search/live-counters";
import { CHECK_CTA } from "@/components/site/cta";
import { HeroReveal } from "@/components/marketing/hero-reveal";
import { RouteField } from "@/components/marketing/route-field";
import { Stages, type Stage } from "@/components/marketing/scroll-choreo";
import { Magnetic } from "@/components/motion/magnetic";
import { PageTransition } from "@/components/motion/page-transition";

const STEP_ICONS: LucideIcon[] = [SearchCheckIcon, CalculatorIcon, FileSignatureIcon, LandmarkIcon];
const STEP_DETAIL: string[][] = [
  [
    "Only a name and a state. No folio number, PAN or certificate needed.",
    "Spelling variants are matched together.",
    "Add a joint holder or another family member in the same check.",
  ],
  [
    "Shares today after every bonus and split, estimated at the latest available market price.",
    "Unclaimed dividends added up.",
    "A custom quote after the free trace. Nothing to pay upfront.",
  ],
  [
    "Every form, affidavit and filing prepared and executed by Finsol.",
    "You sign once, digitally, after reading every page.",
    "A named analyst follows up until approval.",
  ],
  [
    "Shares go straight to your own demat account.",
    "Money goes straight to your own bank account.",
    "We never hold your shares or your money.",
  ],
];
const STAGES: Stage[] = SERVICE_STEPS.map((s, i) => {
  const Icon = STEP_ICONS[i]!;
  return {
    title: `${s.step}. ${s.title}`,
    body: s.body,
    detail: STEP_DETAIL[i]!,
    icon: <Icon />,
  };
});

const PROMISES: { title: string; body: string; Icon: LucideIcon }[] = [
  {
    title: "No Upfront Fee",
    body: "Nothing is payable to start, to trace or to file.",
    Icon: BadgeIndianRupeeIcon,
  },
  {
    title: "No Recovery, No Fee",
    body: "Our fee is due only after value reaches your own demat or bank account.",
    Icon: HandshakeIcon,
  },
  {
    title: "Confidential Handling",
    body: "Your details are used only for your recovery, shared only where your claim needs them.",
    Icon: LockKeyholeIcon,
  },
];

const FRAUD_RULES = [
  "Nobody can “release” shares for an upfront fee or a “processing charge”. We never ask for one.",
  "Never read out an OTP, password, UPI PIN or demat login to anyone, including us.",
  "Never sign blank forms or blank transfer deeds.",
  `Genuine email from us comes only from @${BRAND.domain}.`,
];

export default function LandingPage() {
  return (
    <PageTransition>
      {/* The first viewport: the promise and the 3-Minute Check. */}
      <section
        aria-labelledby="hero-heading"
        className="relative isolate overflow-hidden border-b border-(--glass-border)"
      >
        <div aria-hidden="true" className="hero-mesh pointer-events-none absolute inset-0 -z-10" />
        <div className="relative mx-auto grid max-w-[1200px] px-4 pt-12 pb-12 sm:px-6 sm:pt-16 lg:min-h-[min(820px,calc(100dvh-4rem))] lg:grid-cols-12 lg:items-center lg:pt-14 lg:pb-20">
          <HeroReveal className="relative z-10 lg:col-span-7">
            <p
              data-hero-reveal
              data-hero-follow
              className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-(--glass-border) bg-(--glass-elevated) px-3 py-1 text-sm font-medium text-fg-2 shadow-(--glass-rim) backdrop-blur-md"
            >
              <span aria-hidden="true" className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-cyan opacity-70" />
                <span className="relative inline-flex size-2 rounded-full bg-brand-cyan" />
              </span>
              {BRAND.promise.join(" • ")}
            </p>
            <h1
              id="hero-heading"
              data-hero-reveal
              data-hero-heading
              className="display mt-6 max-w-[16ch] text-[clamp(2.5rem,5.6vw,4.75rem)] text-fg"
            >
              <span className="text-gradient-cyan">Your family&apos;s forgotten shares,</span>{" "}
              <span className="text-fg-3">recovered for you.</span>
            </h1>
            <p
              data-hero-reveal
              data-hero-follow
              className="mt-6 max-w-[46ch] text-lg leading-relaxed text-fg-2"
            >
              {BRAND.name} finds unclaimed shares and dividends and recovers them end to end. You
              only need a name and a state to start.
            </p>
            {/* The check itself paints immediately: no entrance animation on the form. */}
            <div className="mt-8 max-w-[44rem]">
              <UnclaimedSearchForm />
            </div>
          </HeroReveal>
          {/* Its own column on wide screens, so the drawing never runs behind the search card. */}
          <RouteField className="mt-10 h-64 [mask-image:linear-gradient(to_bottom,black_70%,transparent)] sm:h-80 lg:col-span-5 lg:mt-0 lg:h-[34rem] lg:[mask-image:linear-gradient(to_right,transparent,black_22%)]" />
          <div className="relative z-10 mt-10 lg:col-span-12 lg:mt-12">
            <LiveCounters />
          </div>
        </div>
      </section>

      {/* The three promises, directly under the hero. */}
      <section aria-label="Our promise" className="border-b border-(--glass-border) bg-ink-900/50">
        <ul className="mx-auto grid max-w-[1200px] divide-y divide-(--glass-border) px-4 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-6">
          {PROMISES.map(({ title, body, Icon }) => (
            <li key={title} className="flex gap-3 py-6 sm:px-6 sm:first:pl-0">
              <Icon className="mt-0.5 size-5 shrink-0 text-signal" aria-hidden="true" />
              <div>
                <p className="text-base font-semibold text-fg">{title}</p>
                <p className="mt-1 text-sm text-fg-2">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* The turnkey service: four steps, drawn by scroll. */}
      <section
        id="how-it-works"
        aria-labelledby="how-heading"
        className="scroll-mt-20 border-b border-(--glass-border)"
      >
        <div className="mx-auto max-w-[1200px] px-4 py-24 sm:px-6 md:py-32">
          <p className="text-sm font-medium text-signal">
            The Finsol 4-Step Turnkey Recovery Service
          </p>
          <h2
            id="how-heading"
            className="mt-3 max-w-[24ch] text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1] text-fg"
          >
            You tell us a name. We do everything else.
          </h2>
          <div className="mt-16 lg:mt-20">
            <Stages stages={STAGES} />
          </div>
        </div>
      </section>

      {/* Calculator teaser. */}
      <section aria-labelledby="calc-heading" className="border-b border-(--glass-border)">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-20 sm:px-6 md:py-24 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7">
            <h2
              id="calc-heading"
              className="max-w-[22ch] text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1] text-fg"
            >
              100 shares bought decades ago can be thousands today.
            </h2>
            <p className="mt-5 max-w-[52ch] text-lg text-fg-2">
              Bonuses and splits multiply old holdings. Add each stock your family held and see the
              estimated value at the latest available price, with dividends declared since shown
              separately.
            </p>
          </div>
          <div className="lg:col-span-5">
            <Button asChild size="lg" variant="outline">
              <Link href="/calculator">
                <CalculatorIcon aria-hidden="true" />
                Open the Family Wealth Calculator
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Pricing: custom, contingent, nothing upfront. No public percentages. */}
      <section
        id="pricing"
        aria-labelledby="pricing-heading"
        className="scroll-mt-20 border-b border-(--glass-border) bg-ink-900/50"
      >
        <div className="mx-auto grid max-w-[1200px] gap-12 px-4 py-24 sm:px-6 md:py-32 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-6">
            <h2
              id="pricing-heading"
              className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1] text-fg"
            >
              {PUBLIC_PRICING.headline}
            </h2>
            <p className="display text-gradient-cyan mt-6 text-[clamp(3.5rem,9vw,6.5rem)] leading-none">
              ₹0
            </p>
            <p className="mt-3 text-lg text-fg">upfront fee, ever.</p>
          </div>
          <div className="lg:col-span-6">
            <p className="text-lg text-fg-2">
              Every family&apos;s holdings are different, so every quote is too. After your free
              trace, your analyst sends a tailored contingency quote: a share of what is actually
              recovered, payable only after credit.
            </p>
            <ul className="mt-6 space-y-3 text-base text-fg-2">
              {[
                "No Upfront Fee: nothing to start, trace or file.",
                "No Recovery, No Fee: if nothing is credited, you owe nothing.",
                "Confidential Handling: your quote is private, and documents go only to the parties your claim needs.",
              ].map((t) => (
                <li key={t} className="flex gap-3">
                  <ShieldCheckIcon
                    className="mt-0.5 size-5 shrink-0 text-confirmed"
                    aria-hidden="true"
                  />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Anti-fraud: quiet, plain, no motion. */}
      <section aria-labelledby="fraud-heading" className="border-b border-(--glass-border)">
        <div className="mx-auto grid max-w-[1200px] gap-12 px-4 py-24 sm:px-6 md:py-32 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <span
              aria-hidden="true"
              className="grid size-12 place-items-center rounded-[14px] border border-blocker/35 bg-blocker-wash text-blocker"
            >
              <ShieldAlertIcon className="size-6" />
            </span>
            <h2
              id="fraud-heading"
              className="mt-6 text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1] text-fg"
            >
              Protect yourself from recovery fraud
            </h2>
            <p className="mt-5 max-w-[40ch] text-lg text-fg-2">
              Unclaimed shares attract fake agents. These rules keep you safe.
            </p>
          </div>
          <div className="lg:col-span-7">
            <ul className="panel divide-y divide-(--glass-border)">
              {FRAUD_RULES.map((t) => (
                <li key={t} className="flex gap-4 px-5 py-5 text-base text-fg sm:px-6">
                  <BanIcon className="mt-1 size-4 shrink-0 text-blocker" aria-hidden="true" />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Contact desks. */}
      <section
        id="contact"
        aria-labelledby="contact-heading"
        className="scroll-mt-20 border-b border-(--glass-border)"
      >
        <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 md:py-24">
          <h2
            id="contact-heading"
            className="text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1] text-fg"
          >
            Talk to the right desk
          </h2>
          {/* Contact routes are essential: no entrance animation, always visible. */}
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BRAND_DESKS.map((d) => (
              <li key={d.key}>
                <a
                  href={`mailto:${d.email}`}
                  className="panel vault-glass-hover flex h-full flex-col gap-2 p-5 focus-visible:outline-2 focus-visible:outline-signal"
                >
                  {d.key === "partners" ? (
                    <BriefcaseBusinessIcon className="size-5 text-signal" aria-hidden="true" />
                  ) : (
                    <MailIcon className="size-5 text-signal" aria-hidden="true" />
                  )}
                  <span className="font-semibold text-fg">{d.label}</span>
                  <span className="text-sm break-all text-fg-2">{d.email}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* A real close. */}
      <section aria-labelledby="cta-heading">
        <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 md:py-28">
          <VaultCard
            lift
            className="relative isolate flex flex-col items-start gap-8 overflow-hidden p-8 sm:p-12 md:flex-row md:items-end md:justify-between"
          >
            <div aria-hidden="true" className="hero-mesh absolute inset-0 -z-10 opacity-80" />
            <div>
              <h2
                id="cta-heading"
                className="text-gradient-cyan text-[clamp(1.75rem,3.4vw,2.75rem)] leading-[1.1]"
              >
                Three minutes to know what your family holds.
              </h2>
              <p className="mt-4 max-w-[52ch] text-lg text-fg-2">
                A name and a state. {BRAND.promise.join(" • ")}.
              </p>
            </div>
            <Magnetic>
              <Button asChild size="lg" className="sheen whitespace-nowrap">
                <Link href="/search" transitionTypes={["nav-forward"]}>
                  {CHECK_CTA}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </Magnetic>
          </VaultCard>
        </div>
      </section>
    </PageTransition>
  );
}
