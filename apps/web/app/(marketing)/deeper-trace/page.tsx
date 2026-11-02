import type { Metadata } from "next";
import { cookies } from "next/headers";
import { BRAND } from "@finsol/shared";

import { DeeperTrace } from "@/components/search/deeper-trace";
import { SESSION_COOKIE } from "@/lib/api/config";

export const metadata: Metadata = {
  title: "Deeper Trace: ask our analysts to look further",
  description:
    "Old certificates, name variations and suspense-account shares often appear in no published list. Tell us what you know and a Finsol analyst searches the records we are authorised to search.",
  alternates: { canonical: "/deeper-trace" },
};

export default async function DeeperTracePage() {
  const signedIn = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
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
        <DeeperTrace holderName="" scope="ALL_INDIA" signedIn={signedIn} />
      </div>
    </div>
  );
}
