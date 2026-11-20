"use client";

import { useRef } from "react";

import { gsap, SplitText, useGSAP, MOTION_QUERIES } from "@/lib/motion/gsap";

/**
 * The focal entrance: headline lines rise out of a mask once, then the
 * sentence and the action settle. Elements marked [data-hero-reveal] are
 * hidden by CSS only when motion is allowed (see globals.css failsafe).
 */
export function HeroReveal({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      const heading = root.querySelector<HTMLElement>("[data-hero-heading]");
      const follow = root.querySelectorAll<HTMLElement>("[data-hero-follow]");
      const all = root.querySelectorAll<HTMLElement>("[data-hero-reveal]");

      const mm = gsap.matchMedia();
      mm.add(MOTION_QUERIES.motion, () => {
        if (!heading) {
          gsap.set(all, { visibility: "visible" });
          return;
        }
        const split = SplitText.create(heading, {
          type: "lines",
          mask: "lines",
          linesClass: "hero-line",
          autoSplit: true,
          onSplit(self) {
            gsap.set(all, { visibility: "visible" });
            return gsap
              .timeline()
              .from(self.lines, { yPercent: 108, duration: 0.6, stagger: 0.06 })
              .from(follow, { autoAlpha: 0, y: 10, duration: 0.4, stagger: 0.05 }, "-=0.45");
          },
        });
        return () => split.revert();
      });
      mm.add(MOTION_QUERIES.reduce, () => {
        gsap.set(all, { visibility: "visible" });
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
