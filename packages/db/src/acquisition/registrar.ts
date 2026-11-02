/**
 * Which registrar and share transfer agent (RTA) an issuer names on its own
 * investor pages. Listed companies must publish their RTA's details, usually
 * as "Registrar and Share Transfer Agent: <name>". A registrar is recorded
 * only when one name clearly dominates the pages read; otherwise nothing is
 * recorded (no guessing).
 */

/** Canonical names, with the spellings and former names issuers still print. */
export const REGISTRARS: { name: string; pattern: RegExp }[] = [
  {
    name: "KFin Technologies Limited",
    pattern: /\bk\s?fin\s*tech(nologies)?\b|\bkfintech\b|\bkarvy\s+(fintech|computershare)\b/gi,
  },
  { name: "MUFG Intime India Private Limited", pattern: /\bmufg\s+intime\b|\blink\s*intime\b/gi },
  { name: "TSR Consultants Private Limited", pattern: /\btsr\s+(consultants|darashaw)\b/gi },
  { name: "Bigshare Services Private Limited", pattern: /\bbigshare\s+services\b/gi },
  { name: "Cameo Corporate Services Limited", pattern: /\bcameo\s+corporate\b/gi },
  {
    name: "Integrated Registry Management Services Private Limited",
    pattern: /\bintegrated\s+registry\s+management\b/gi,
  },
  { name: "Alankit Assignments Limited", pattern: /\balankit\s+assignments\b/gi },
  {
    name: "Skyline Financial Services Private Limited",
    pattern: /\bskyline\s+financial\s+services\b/gi,
  },
  {
    name: "Beetal Financial & Computer Services Private Limited",
    pattern: /\bbeetal\s+financial\b/gi,
  },
  { name: "MAS Services Limited", pattern: /\bmas\s+services\s+(ltd|limited)\b/gi },
  { name: "Purva Sharegistry (India) Private Limited", pattern: /\bpurva\s+share\s?gistry\b/gi },
  {
    name: "Datamatics Business Solutions Limited",
    pattern: /\bdatamatics\s+business\s+solutions\b/gi,
  },
  { name: "Sharex Dynamic (India) Private Limited", pattern: /\bsharex\s+dynamic\b/gi },
  { name: "Niche Technologies Private Limited", pattern: /\bniche\s+technologies\b/gi },
  { name: "Maheshwari Datamatics Private Limited", pattern: /\bmaheshwari\s+datamatics\b/gi },
  { name: "Canbank Computer Services Limited", pattern: /\bcanbank\s+computer\s+services\b/gi },
  {
    name: "Universal Capital Securities Private Limited",
    pattern: /\buniversal\s+capital\s+securities\b/gi,
  },
  {
    name: "Adroit Corporate Services Private Limited",
    pattern: /\badroit\s+corporate\s+services\b/gi,
  },
  {
    name: "Satellite Corporate Services Private Limited",
    pattern: /\bsatellite\s+corporate\s+services\b/gi,
  },
  { name: "Computech Sharecap Limited", pattern: /\bcomputech\s+sharecap\b/gi },
];

/** Visible text of an HTML page (scripts, styles and tags removed). */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

export interface RegistrarTally {
  /** Mentions per canonical registrar name, with the first page naming it. */
  counts: Map<string, { mentions: number; nearRegistrarWord: number; foundOn: string }>;
}

export function newTally(): RegistrarTally {
  return { counts: new Map() };
}

/** Adds one page's mentions. Mentions within 120 characters of "registrar" or "RTA" weigh more. */
export function tallyPage(tally: RegistrarTally, text: string, url: string): void {
  for (const r of REGISTRARS) {
    for (const m of text.matchAll(r.pattern)) {
      const at = m.index ?? 0;
      const context = text.slice(Math.max(0, at - 120), at + 120);
      const near = /registrar|\brta\b|share\s+transfer\s+agent/i.test(context) ? 1 : 0;
      const t = tally.counts.get(r.name) ?? { mentions: 0, nearRegistrarWord: 0, foundOn: url };
      t.mentions++;
      t.nearRegistrarWord += near;
      tally.counts.set(r.name, t);
    }
  }
}

/**
 * The registrar the pages name, or null. Requires at least one mention next
 * to the word "registrar"/"RTA", and that the leading name has at least twice
 * the weighted mentions of any other (pages that discuss several registrars,
 * e.g. after a change of RTA, record nothing).
 */
export function decideRegistrar(tally: RegistrarTally): { name: string; foundOn: string } | null {
  const scored = [...tally.counts.entries()]
    .map(([name, t]) => ({
      name,
      foundOn: t.foundOn,
      near: t.nearRegistrarWord,
      score: t.mentions + 2 * t.nearRegistrarWord,
    }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.near === 0) return null;
  const second = scored[1];
  if (second && second.score * 2 > top.score) return null;
  return { name: top.name, foundOn: top.foundOn };
}
