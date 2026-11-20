import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ALL_INDIA, BRAND, isIndianState } from "@finsol/shared";

import { DeeperTrace } from "@/components/search/deeper-trace";
import { SESSION_COOKIE } from "@/lib/api/config";

export const metadata: Metadata = {
  title: "Deeper Trace: ask our analysts to look further",
  description:
    "Old certificates, name variations and suspense-account shares often appear in no published list. Tell us what you know and a Finsol analyst searches the records we are authorised to search.",
  alternates: { canonical: "/deeper-trace" },
};

type Params = Record<string, string | string[] | undefined>;
/** One trimmed, length-capped value. Handoffs carry only a name, a state and a company. */
const one = (v: string | string[] | undefined, max = 120) =>
  ((Array.isArray(v) ? v[0] : v) ?? "").trim().slice(0, max);

export default async function DeeperTracePage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
  const state = one(p.state);
  const scope = state === ALL_INDIA || isIndianState(state) ? state : ALL_INDIA;
  return (
    <div className="mx-auto max-w-[1200px] px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="display max-w-[22ch] text-[clamp(2rem,4vw,3rem)] text-fg">Deeper Trace</h1>
      <p className="mt-4 max-w-[62ch] text-lg text-fg-2">
        Physical certificates, name variations, old addresses and shares held in company suspense
        accounts often appear in none of the published lists. Tell us what you know and our analysts
        look further.
      </p>
      <p className="mt-2 text-sm font-medium text-signal">{BRAND.promise.join(" • ")}</p>
      <div className="mt-10">
        <DeeperTrace
          holderName={one(p.name)}
          scope={scope}
          company={one(p.company)}
          signedIn={signedIn}
        />
      </div>
    </div>
  );
}
