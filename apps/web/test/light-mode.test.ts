import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

describe("permanent light mode", () => {
  it("renders the document light, with no script that could switch it", () => {
    const layout = read("../app/layout.tsx");
    expect(layout).toContain('data-theme="light"');
    expect(layout).toContain('colorScheme: "light"');
    expect(layout).not.toMatch(/localStorage|finsol:theme|data-theme="dark"/);
  });

  it("has no theme toggle", () => {
    expect(existsSync(resolve(import.meta.dirname, "../components/theme/theme-toggle.tsx"))).toBe(
      false,
    );
    for (const f of [
      "../components/site/marketing-header.tsx",
      "../components/site/app-header.tsx",
    ])
      expect(read(f)).not.toContain("ThemeToggle");
  });

  it("ties Tailwind's dark: variant to a theme that is never set, not to the OS", () => {
    expect(read("../app/globals.css")).toContain(
      '@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
  });
});
