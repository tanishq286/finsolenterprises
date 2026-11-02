import { describe, expect, it } from "vitest";
import { classifyDocument, snapshotBasis } from "../src/acquisition/classify.js";

describe("source classification must not invent completed transfers", () => {
  it("holds generic IEPF share lists for review", () => {
    expect(
      snapshotBasis(
        classifyDocument("https://issuer.example/iepf/shares.pdf", "IEPF shareholder list")
          .docClass,
      ),
    ).toBeNull();
  });
  it("keeps proposed transfers separate", () => {
    expect(
      snapshotBasis(
        classifyDocument("https://issuer.example/list.pdf", "Shares to be transferred to IEPF")
          .docClass,
      ),
    ).toBe("PROPOSED_IEPF_TRANSFER");
  });
  it("recognizes explicit completed transfers", () => {
    expect(
      snapshotBasis(
        classifyDocument("https://issuer.example/list.pdf", "Shares transferred to IEPF").docClass,
      ),
    ).toBe("TRANSFERRED_TO_IEPF");
  });
  it("does not crash on literal percent signs", () => {
    expect(() =>
      classifyDocument("https://issuer.example/list.pdf", "100% unclaimed dividend list"),
    ).not.toThrow();
  });
});
