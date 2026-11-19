import { describe, expect, it } from "vitest";

import { normalizePan, PAN_PATTERN } from "../src/index.js";

describe("PAN helpers", () => {
  it("trims and uppercases a typed PAN", () => {
    expect(normalizePan("  abcpk4321z ")).toBe("ABCPK4321Z");
    expect(normalizePan(undefined)).toBe("");
    expect(normalizePan("   ")).toBe("");
  });

  it("accepts 5 letters, 4 digits, 1 letter and nothing else", () => {
    expect(PAN_PATTERN.test("ABCPK4321Z")).toBe(true);
    for (const bad of ["ABCP4321KZ", "ABCPK4321", "ABCPK43210Z", "ABC-K4321Z", "abcpk4321z"])
      expect(PAN_PATTERN.test(bad), bad).toBe(false);
  });
});
