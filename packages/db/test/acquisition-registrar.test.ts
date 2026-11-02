import { describe, expect, it } from "vitest";

import { decideRegistrar, newTally, pageText, tallyPage } from "../src/acquisition/registrar.js";

const decide = (...pages: string[]) => {
  const t = newTally();
  pages.forEach((html, i) => tallyPage(t, pageText(html), `https://issuer.example.test/p${i}`));
  return decideRegistrar(t);
};

describe("registrar named on an issuer's pages", () => {
  it("records the registrar named next to 'Registrar and Share Transfer Agent'", () => {
    expect(
      decide(
        "<p>Registrar and Share Transfer Agent:</p><p>KFin Technologies Limited, Selenium Tower B</p>",
      ),
    ).toEqual({ name: "KFin Technologies Limited", foundOn: "https://issuer.example.test/p0" });
  });

  it("maps former names to the current registrar", () => {
    expect(decide("<td>RTA</td><td>Link Intime India Pvt. Ltd.</td>")?.name).toBe(
      "MUFG Intime India Private Limited",
    );
    expect(decide("Registrar: Karvy Fintech Private Limited")?.name).toBe(
      "KFin Technologies Limited",
    );
  });

  it("records nothing without the word registrar or RTA nearby", () => {
    expect(decide("<p>Our partners include KFin Technologies for mutual funds.</p>")).toBeNull();
  });

  it("records nothing when two registrars are named about equally (e.g. a change of RTA)", () => {
    expect(
      decide(
        "Registrar changed from Link Intime India to KFin Technologies. RTA contacts: KFin Technologies, Link Intime India",
      ),
    ).toBeNull();
  });

  it("ignores names inside scripts", () => {
    expect(
      decide(
        "<script>var rta='Bigshare Services registrar';</script><p>Registrar: Cameo Corporate Services</p>",
      )?.name,
    ).toBe("Cameo Corporate Services Limited");
  });
});
