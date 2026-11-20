import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { callApi } from "../lib/api/client";

const read = (p: string) => readFileSync(resolve(import.meta.dirname, p), "utf8");

describe("company + folio lookup sends JSON POST (never folio in URL)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("callApi sends POST /api/v1/search/folio with JSON body and no query string", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            mode: "COMPANY_FOLIO",
            access: "public",
            companyMatched: true,
            found: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await callApi("search/folio", {
      method: "POST",
      body: { company: "Reliance Industries", folio: "RIL0012345621" },
    });

    expect(res).toEqual({
      mode: "COMPANY_FOLIO",
      access: "public",
      companyMatched: true,
      found: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/search/folio");
    expect(url).not.toContain("?");
    expect(url).not.toContain("RIL0012345621");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      company: "Reliance Industries",
      folio: "RIL0012345621",
    });
  });

  it("FolioLookup submits via JSON POST and keeps the folio out of URLs and public copy safe", () => {
    const src = read("../components/search/folio-lookup.tsx");
    expect(src).toContain('callApi<FolioSearchResponse>("search/folio"');
    expect(src).toContain('method: "POST"');
    expect(src).toContain("body: { company: company.trim(), folio: folio.trim() }");
    expect(src).not.toContain("search/folio?");
    expect(src).not.toMatch(/URLSearchParams\(\s*\{[^}]*folio/);
    expect(src).not.toMatch(/IEPF-5|iepf\.gov\.in|mca\.gov\.in|nodal officer/i);
  });

  it("the BFF proxy allows POST on search/folio and forwards bodies with no-store caching", () => {
    const route = read("../app/api/v1/[...path]/route.ts");
    const match = route.match(/const ALLOWED =\s*(\/[^\n]+\/);/);
    expect(match).not.toBeNull();
    const allowed = new RegExp(match![1]!.slice(1, -1));
    expect(allowed.test("search/folio")).toBe(true);
    expect(route).toContain("forward as POST");
    expect(route).toContain('const hasBody = req.method !== "GET" && req.method !== "HEAD"');
    expect(route).toContain('"cache-control": "private, no-store, no-transform"');
  });
});
