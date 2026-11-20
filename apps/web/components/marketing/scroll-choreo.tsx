"use client";

import { useRef } from "react";

import { gsap, ScrollTrigger, useGSAP, MOTION_QUERIES } from "@/lib/motion/gsap";

/**
 * A list that appears as a list: items settle in once, 60ms apart.
 * Content is visible by default; motion only runs when allowed, and never
 * makes content unreachable: items already on screen are left alone, hidden
 * items stay focusable (opacity, not visibility), focus reveals an item at
 * once, and everything is shown after a short fallback even if no scroll
 * event ever fires.
 */
export function RevealBatch({
  children,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "ul";
}) {
  const scope = useRef<HTMLDivElement & HTMLUListElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_QUERIES.motion, () => {
        const all = gsap.utils.toArray<HTMLElement>("[data-reveal-item]", scope.current);
        const items = all.filter(
          (el) => el.getBoundingClientRect().top > window.innerHeight * 0.88,
        );
        if (!items.length) return;
        const show = (els: Element[]) =>
          gsap.to(els, { opacity: 1, y: 0, duration: 0.7, stagger: 0.06, overwrite: true });
        gsap.set(items, { opacity: 0, y: 16 });
        ScrollTrigger.batch(items, { start: "top 88%", once: true, onEnter: show });
        const onFocus = (e: FocusEvent) => {
          const item = (e.target as HTMLElement).closest("[data-reveal-item]");
          if (item) gsap.set(item, { opacity: 1, y: 0, overwrite: true });
        };
        scope.current?.addEventListener("focusin", onFocus);
        const fallback = window.setTimeout(() => show(items), 2500);
        return () => {
          scope.current?.removeEventListener("focusin", onFocus);
          window.clearTimeout(fallback);
        };
      });
    },
    { scope },
  );
  return (
    <Tag ref={scope} className={className}>
      {children}
    </Tag>
  );
}

/**
 * The worked example prints like a statement: each line is revealed from its
 * top edge in turn, then the total's rule is drawn. Plays once.
 */
export function LedgerPrint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_QUERIES.motion, () => {
        const rows = gsap.utils.toArray<HTMLElement>("[data-ledger-row]", scope.current);
        const rule = scope.current?.querySelector("[data-ledger-rule]");
        const tl = gsap.timeline({
          scrollTrigger: { trigger: scope.current, start: "top 78%", once: true },
        });
        tl.from(rows, {
          clipPath: "inset(0% 0% 100% 0%)",
          autoAlpha: 0,
          duration: 0.6,
          stagger: 0.14,
          ease: "power3.out",
          clearProps: "clipPath",
        });
        if (rule) tl.from(rule, { scaleX: 0, transformOrigin: "0% 50%", duration: 0.7 }, "-=0.2");
      });
    },
    { scope },
  );
  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  );
}

export interface Stage {
  title: string;
  body: string;
  detail: string[];
  icon: React.ReactNode;
}

/**
 * How it works, as one sequence. On wide screens the stage index stays in view
 * while each stage passes; the route line is drawn by scroll and the active
 * stage lights. On narrow screens it is a plain, static sequence.
 */
export function Stages({ stages }: { stages: Stage[] }) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      const items = gsap.utils.toArray<HTMLElement>("[data-stage]", root);
      const index = gsap.utils.toArray<HTMLElement>("[data-stage-index]", root);
      const route = root.querySelector<SVGPathElement>("[data-stage-route]");
      const setActive = (i: number) =>
        index.forEach((el, j) => el.toggleAttribute("data-active", j === i));

      const mm = gsap.matchMedia();
      mm.add(MOTION_QUERIES.wide, () => {
        // The lit stage is the last card whose top has crossed 55% of the
        // viewport, read from layout on every update. Per-card toggles missed
        // a stage when a fast scroll jumped clean over it.
        const pick = () => {
          const line = window.innerHeight * 0.55;
          let current = 0;
          items.forEach((item, i) => {
            if (item.getBoundingClientRect().top <= line) current = i;
          });
          setActive(current);
        };
        ScrollTrigger.create({
          trigger: root.querySelector("[data-stage-list]"),
          start: "top bottom",
          end: "bottom top",
          onUpdate: pick,
          onRefresh: pick,
        });
        pick();
        if (route && matchMedia(MOTION_QUERIES.motion).matches) {
          gsap.fromTo(
            route,
            { drawSVG: "0%" },
            {
              drawSVG: "100%",
              ease: "none",
              scrollTrigger: {
                trigger: root.querySelector("[data-stage-list]"),
                start: "top 55%",
                end: "bottom 55%",
                scrub: 0.6,
              },
            },
          );
        }
        return () => index.forEach((el) => el.removeAttribute("data-active"));
      });
    },
    { scope },
  );

  return (
    <div ref={scope} className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
      <div className="hidden lg:block" aria-hidden="true">
        <div className="sticky top-32 flex gap-6">
          <svg viewBox="0 0 12 300" className="h-[300px] w-3 shrink-0" fill="none">
            <path d="M6 6 V 294" stroke="var(--color-line)" strokeWidth="1.5" />
            <path
              data-stage-route
              d="M6 6 V 294"
              stroke="var(--color-signal)"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <ol className="flex h-[300px] flex-col justify-between">
            {stages.map((s) => (
              <li
                key={s.title}
                data-stage-index
                className="group flex items-center gap-3 text-2xl font-[560] tracking-[-0.02em] text-fg-3 transition-colors duration-300 ease-(--ease-out) [font-stretch:106%] data-[active]:text-fg"
              >
                <span className="size-2 shrink-0 rounded-full bg-control transition-[background-color,transform,box-shadow] duration-300 ease-(--ease-out) group-data-[active]:scale-125 group-data-[active]:bg-brand-cyan group-data-[active]:shadow-[0_0_12px_var(--color-brand-cyan)]" />
                {s.title}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <ol data-stage-list className="space-y-6 lg:space-y-0">
        {stages.map((s, i) => (
          <li
            key={s.title}
            data-stage
            className="relative border-l border-(--glass-border) pb-2 pl-6 lg:flex lg:min-h-[58vh] lg:flex-col lg:justify-center lg:border-l-0 lg:pl-0"
          >
            <span
              aria-hidden="true"
              className="absolute top-8 -left-[5px] size-2.5 rounded-full border border-signal bg-ink-950 lg:hidden"
            />
            <div className="panel vault-card max-w-[40rem] p-6 sm:p-8">
              <div
                aria-hidden="true"
                className="grid size-11 place-items-center rounded-[12px] border border-signal/25 bg-signal-wash text-signal [&_svg]:size-[1.375rem]"
              >
                {s.icon}
              </div>
              <h3 className="mt-5 text-[1.75rem] leading-tight font-[560] tracking-[-0.02em] text-fg [font-stretch:106%]">
                <span className="sr-only">
                  Stage {i + 1} of {stages.length}:{" "}
                </span>
                {s.title}
              </h3>
              <p className="mt-3 max-w-[46ch] text-lg text-fg-2">{s.body}</p>
              <ul className="mt-6 max-w-[52ch] space-y-3 border-t border-(--glass-border) pt-5">
                {s.detail.map((d) => (
                  <li key={d} className="flex gap-3 text-base text-fg-2">
                    <span
                      aria-hidden="true"
                      className="mt-[0.7em] h-px w-3 shrink-0 bg-signal/60"
                    />
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
