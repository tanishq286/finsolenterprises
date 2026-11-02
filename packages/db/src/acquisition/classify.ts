/**
 * What a document on an issuer's investor page probably is, from its URL and
 * link text. A hint for prioritising and labelling only: whether a file is a
 * holder dataset is decided by parsing it, and a share list whose basis
 * (proposed vs transferred) is unclear is held for review, never assumed.
 */
export type DocClass =
  | "UNCLAIMED_DIVIDEND_LIST"
  | "IEPF_PROPOSED_TRANSFER"
  | "IEPF_TRANSFERRED"
  | "SUSPENSE_DISCLOSURE"
  | "NOTICE"
  | "PROCEDURE"
  | "OTHER";

/** Classes that can hold holder-level rows. */
export const HOLDER_CLASSES: readonly DocClass[] = [
  "UNCLAIMED_DIVIDEND_LIST",
  "IEPF_PROPOSED_TRANSFER",
  "IEPF_TRANSFERRED",
  "SUSPENSE_DISCLOSURE",
  "OTHER",
];

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const norm = (s: string) =>
  safeDecode(s)
    .toLowerCase()
    .replace(/[_\-.+%/]+/g, " ")
    .replace(/\s+/g, " ");

export function classifyDocument(
  url: string,
  label = "",
): { docClass: DocClass; periodHint: string | null } {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep as given */
  }
  const t = norm(`${path} ${label}`);
  const shares = /\bshares?\b|\bshareholders?\b|\biepf ?4\b|equity/.test(t);
  const dividend = /\bdiv(idend)?s?\b|div ?\d{4}|\biepf ?2\b|unpaid|unclaimed amount/.test(t);
  const proposed =
    /tentative|proposed|to be transferred|due (for|to) (be )?transfer|liable|eligible for transfer|being transferred/.test(
      t,
    );
  const transferred =
    /transferred|\btrfd\b|\btrf\b|credit(ed)? of shares|credited to iepf|shares trf|\biepf ?4\b/.test(
      t,
    );
  const notice =
    /notice|newspaper|advertisement|advt|publication|intimation to stock|communication on deduction of tax/.test(
      t,
    );
  const procedure =
    /faq|procedure|process|form|guideline|nodal|how to claim|claim process|documents required/.test(
      t,
    );

  let docClass: DocClass = "OTHER";
  if (/suspense/.test(t)) docClass = "SUSPENSE_DISCLOSURE";
  else if (procedure && !/list/.test(t)) docClass = "PROCEDURE";
  else if (notice && !/list/.test(t)) docClass = "NOTICE";
  else if (shares && proposed) docClass = "IEPF_PROPOSED_TRANSFER";
  else if (shares && transferred) docClass = "IEPF_TRANSFERRED";
  else if (dividend || /unclaimed|unpaid/.test(t)) docClass = "UNCLAIMED_DIVIDEND_LIST";

  const years = [...t.matchAll(/\b(19[89]\d|20[0-4]\d)\b/g)].map((m) => m[1]!);
  const fy = /\b(20\d{2}) ?(?:to )?(\d{2,4})\b/.exec(t);
  const periodHint =
    fy && Number(fy[2]!.slice(-2)) === (Number(fy[1]) + 1) % 100
      ? `FY ${fy[1]}-${fy[2]!.slice(-2)}`
      : years.length
        ? [...new Set(years)].sort().join(", ")
        : null;
  return { docClass, periodHint };
}

/** Links on a page that probably lead to IEPF or unclaimed-dividend material. */
export const INVESTOR_LINK =
  /investor|shareholder|iepf|unclaimed|unpaid|dividend|share ?holder|investor ?(relations|services|information|centre|center)/i;

/** The snapshot basis a share list's class supports, or null when it must be reviewed. */
export function snapshotBasis(
  docClass: DocClass,
): "PROPOSED_IEPF_TRANSFER" | "TRANSFERRED_TO_IEPF" | null {
  if (docClass === "IEPF_PROPOSED_TRANSFER") return "PROPOSED_IEPF_TRANSFER";
  if (docClass === "IEPF_TRANSFERRED") return "TRANSFERRED_TO_IEPF";
  return null;
}
