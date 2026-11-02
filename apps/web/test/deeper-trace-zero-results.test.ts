import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** JSX text with entities decoded and whitespace collapsed, as a reader sees it. */
const visible = (path: string) =>
  readFileSync(resolve(import.meta.dirname, path), "utf8")
    .replace(/&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ");

describe("zero-result search and the Deeper Trace intake", () => {
  const page = visible("../app/(marketing)/search/page.tsx");
  const trace = visible("../components/search/deeper-trace.tsx");

  it("shows the reassurance card and the trace form instead of a blank result", () => {
    expect(page).toContain('data-testid="search-no-match"');
    expect(page).toContain(
      "We searched our instant index of top listed companies. Don't worry if your name wasn't found—over 3,000 older companies and physical share certificates require an archival RTA trace.",
    );
    // The card also states how many companies the index really holds.
    expect(page).toContain("data.coverage.companiesWithRecordsCount");
    expect(page).toContain("<DeeperTrace");
  });

  it("asks for the investor, companies, years, addresses and certificate status in step 1", () => {
    for (const label of [
      "Deceased / Investor Full Name",
      "Suspected Companies",
      "Approximate Investment Years",
      "Known Addresses or Old Cities / States",
      "Physical Share Certificate Status",
    ])
      expect(trace).toContain(label);
  });

  it("verifies the claimant's mobile through the real Login Gateway, never on the client", () => {
    expect(trace).toContain("<LoginForm");
    expect(trace).not.toMatch(/auth\/otp\/(request|verify)/);
    expect(trace).not.toMatch(/440200|123456|174082/);
    expect(trace).not.toContain("setOtpVerified(true)");
  });

  it("keeps DIY claim routes and unsupportable promises off the public page", () => {
    for (const text of [page, trace]) {
      expect(text).not.toMatch(/IEPF-5|iepf\.gov\.in|mca\.gov\.in|nodal officer/i);
      expect(text).not.toMatch(/zero-knowledge|end-to-end encrypted|microfilm/i);
    }
  });
});
