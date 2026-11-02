import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Search UI Behavior on Zero Results & Deeper Trace Gateway", () => {
  it("includes the prominent reassuring message in search page on 0 results", () => {
    const pagePath = resolve(__dirname, "../app/(marketing)/search/page.tsx");
    const content = readFileSync(pagePath, "utf8");

    // Must not show blank "no results"
    expect(content).toContain('data-testid="search-no-match"');

    // Must render the exact reassuring message required
    const expectedReassuringText =
      "We searched our instant index of top listed companies. Don't worry if your name wasn't found—over 3,000 older companies and physical share certificates require an archival RTA trace.";
    expect(content).toContain(expectedReassuringText.replace(/'/g, "&apos;"));

    // Must render DeeperTrace component
    expect(content).toContain("<DeeperTrace");
  });

  it("provides 2-step interactive Deeper Trace intake form with mobile OTP and certificate status", () => {
    const componentPath = resolve(__dirname, "../components/search/deeper-trace.tsx");
    const content = readFileSync(componentPath, "utf8");

    // Step 1: Investor, Companies, Years, Known Addresses, Certificate Status
    expect(content).toContain("Deceased / Investor Full Name");
    expect(content).toContain("Suspected Companies");
    expect(content).toContain("Approximate Investment Years");
    expect(content).toContain("Known Addresses or Old Cities / States");
    expect(content).toContain("Physical Share Certificate Status");
    expect(content).toContain("LOST");
    expect(content).toContain("AVAILABLE");
    expect(content).toContain("PARTIAL");

    // Step 2: Claimant Details & Mobile OTP Verification
    expect(content).toContain("Claimant Full Name");
    expect(content).toContain("Relationship to Investor");
    expect(content).toContain("Claimant Email Address");
    expect(content).toContain("Claimant Mobile Number (with OTP Verification)");
    expect(content).toContain("Send OTP");
    expect(content).toContain("Verify OTP");
    expect(content).toContain("Mobile verified securely");

    // Tracking Reference and Status
    expect(content).toContain("Pending Audit");
    expect(content).toContain("Tracking Reference");
    expect(content).toContain("Withdraw request");
  });
});
