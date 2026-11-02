/**
 * Investor name handling. Filings spell the same person many ways
 * ("Agarwal", "Agrawal", "Aggarwal"; "Shri R. K. Srivastava", "Shrivastav"),
 * so search runs on a normalised form plus a phonetic key tuned for Indian
 * names. The database adds trigram similarity, Soundex and Levenshtein on top
 * (see packages/db/prisma/migrations), so the key only has to catch the
 * transliteration variants trigrams miss.
 */

const HONORIFICS = new Set([
  "SHRI",
  "SHREE",
  "SRI",
  "SMT",
  "SMT.",
  "SHRIMATI",
  "KUM",
  "KUMARI",
  "MR",
  "MRS",
  "MS",
  "MISS",
  "DR",
  "LATE",
  "LT",
  "MASTER",
  "BABY",
  "PROF",
  "CAPT",
  "COL",
  "MAJ",
  "SMTI",
]);

/** "  Smt. kamla  devi-AGARWAL " → "KAMLA DEVI AGARWAL" */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return "";
  const words = raw
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Honorifics only count at the front; "Devi Shri" keeps its "Shri".
  let start = 0;
  while (start < words.length - 1 && HONORIFICS.has(words[start]!)) start++;
  return words.slice(start).join(" ");
}

export interface NameParts {
  first: string;
  middle: string;
  last: string;
  full: string;
}

/** Splits a full name into first / middle / last. Single initials stay in the middle name. */
export function splitName(raw: string): NameParts {
  const full = normalizeName(raw);
  const words = full.split(" ").filter(Boolean);
  if (words.length === 0) return { first: "", middle: "", last: "", full: "" };
  if (words.length === 1) return { first: words[0]!, middle: "", last: "", full };
  return {
    first: words[0]!,
    middle: words.slice(1, -1).join(" "),
    last: words[words.length - 1]!,
    full,
  };
}

/**
 * Canonical first / middle / last for a stored holder name. Filings often put
 * the whole name in one column, or a two-word name in the first and middle
 * columns with the last empty; search splits a typed name with splitName, so
 * a stored name without a last name is re-split the same way.
 */
export function canonicalNameParts(parts: {
  first?: string | null;
  middle?: string | null;
  last?: string | null;
}): { first: string; middle: string; last: string } {
  const first = normalizeName(parts.first);
  const middle = normalizeName(parts.middle);
  const last = normalizeName(parts.last);
  if (last) return { first, middle, last };
  const split = splitName([first, middle].filter(Boolean).join(" "));
  return { first: split.first, middle: split.middle, last: split.last };
}

/** Joins provided parts into the canonical full name. */
export function joinName(parts: { first?: string; middle?: string; last?: string }): string {
  return normalizeName([parts.first, parts.middle, parts.last].filter(Boolean).join(" "));
}

const DIGRAPHS: [RegExp, string][] = [
  [/OW/g, "O"],
  [/OU/g, "U"],
  [/AU/g, "O"],
  [/AA/g, "A"],
  [/EE/g, "I"],
  [/II/g, "I"],
  [/OO/g, "U"],
  [/PH/g, "F"],
  [/TH/g, "T"],
  [/DH/g, "D"],
  [/BH/g, "B"],
  [/KH/g, "K"],
  [/GH/g, "G"],
  [/CH/g, "C"],
  [/SH/g, "S"],
  [/JH/g, "J"],
  [/CK/g, "K"],
  [/Q/g, "K"],
  [/W/g, "V"],
  [/Z/g, "J"],
  [/X/g, "KS"],
];

/**
 * Phonetic key for one name word, tolerant of Indian transliteration:
 * aspirates fold into plain stops, w = v, doubled letters collapse and
 * vowels after the first letter drop.
 *   AGARWAL, AGRAWAL, AGGARWAL → AGRVL
 *   SRIVASTAVA, SHRIVASTAV     → SRVSTV
 *   CHAUDHARY, CHOUDHARI       → CDR
 */
export function phoneticKey(word: string): string {
  let w = normalizeName(word).replace(/\s+/g, "");
  if (!w) return "";
  for (const [re, to] of DIGRAPHS) w = w.replace(re, to);
  w = w.replace(/H/g, "");
  w = w.replace(/Y$/, "I");
  w = w.replace(/(.)\1+/g, "$1");
  const head = w[0]!;
  const tail = w.slice(1).replace(/[AEIOUY]/g, "");
  return (head + tail).replace(/(.)\1+/g, "$1");
}

/** Phonetic key for every word of a (possibly multi-word) name part, space-separated. */
export function phoneticKeys(part: string): string {
  return normalizeName(part).split(" ").filter(Boolean).map(phoneticKey).join(" ");
}

/** Plain Levenshtein distance; used to rank and explain matches in tests and the ETL. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}
