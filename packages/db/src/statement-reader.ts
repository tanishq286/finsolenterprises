import * as XLSX from "xlsx";

/**
 * Reads the investor-wise statements companies publish under the IEPF Rules:
 *   IEPF-2  unpaid and unclaimed amounts (dividends, matured deposits) still with the company
 *   IEPF-4  shares transferred, or due to be transferred, to the IEPF Authority
 * Companies post them as .xlsx, legacy .xls, .csv or PDF tables, usually
 * with a title block above the header row. This module turns any of those
 * into a grid of cells and finds the header row; `ingest-iepf.ts` maps it.
 */

export interface RawTable {
  headers: string[];
  rows: unknown[][];
  /** 1-based row (or PDF line) number of the first data row, for error messages. */
  firstDataRow: number;
  /** Sheet name, or "page 1-n" for PDFs. */
  sheet: string;
  /** Extraction notes per row (same order as rows), e.g. "WRAPPED_NAME". */
  rowNotes?: string[][];
  /** Where each row came from, e.g. "page 12, line 31". */
  rowRefs?: string[];
}

export type StatementFormat = "xlsx" | "xls" | "csv" | "pdf";

/**
 * Bumped whenever extraction changes, and stored with every source document
 * and source row, so re-processing can tell which reader produced a value.
 * 2026.11.2: PDF text runs that span two cells are split, and column
 * boundaries come from the empty gutters between columns, not header centres.
 */
export const PARSER_VERSION = "statement-reader/2026.11.3";

export function formatOf(fileName: string, contentType?: string | null): StatementFormat | null {
  const ext = /\.([a-z0-9]+)(?:$|\?)/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === "xlsx" || ext === "xls" || ext === "csv" || ext === "pdf") return ext;
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("spreadsheetml")) return "xlsx";
  if (ct.includes("ms-excel")) return "xls";
  if (ct.includes("csv")) return "csv";
  return null;
}

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * A header row names a folio or demat account column among several short
 * cells. (MCA's own e-form template carries an instructions cell that also
 * mentions "DP Id-Client Id"; it is one long cell, not a header row.)
 */
export function isHeaderRow(cells: unknown[]): boolean {
  const short = cells.map((c) => String(c ?? "").trim()).filter((c) => c && c.length <= 80);
  if (short.length < 3) return false;
  return short.some((c) => {
    const n = norm(c);
    return n.startsWith("folio") || n.includes("dpidclientid");
  });
}

function fromGrid(grid: unknown[][], sheet: string): RawTable | null {
  const headerIndex = grid.findIndex((r) => Array.isArray(r) && isHeaderRow(r));
  if (headerIndex < 0) return null;
  let headers = grid[headerIndex]!.map((c) => String(c ?? "").trim());
  let dataStart = headerIndex + 1;
  // Two-row headers ("Investor" / "First Name"): merge a second header-like row.
  const next = grid[dataStart];
  if (
    next &&
    next.some((c) => /name|number|date|amount/i.test(String(c ?? ""))) &&
    !next.some((c) => /\d{4,}/.test(String(c ?? "")))
  ) {
    headers = headers.map((h, i) => [h, String(next[i] ?? "").trim()].filter(Boolean).join(" "));
    dataStart++;
  }
  return { headers, rows: grid.slice(dataStart), firstDataRow: dataStart + 1, sheet };
}

function readWorkbook(buffer: Buffer, format: "xlsx" | "xls" | "csv"): RawTable {
  const wb = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    raw: format === "csv",
    dense: true,
  });
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, {
      header: 1,
      defval: null,
      blankrows: true,
      raw: true,
    });
    const table = fromGrid(grid, name);
    if (table) return table;
  }
  throw new Error("No header row with a folio number or DP ID-client ID column was found.");
}

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
}

interface PdfLine {
  y: number;
  page: number;
  items: PdfItem[];
}

interface Column {
  left: number;
  right: number;
  items: PdfItem[];
}

/** Approximate advance widths (Helvetica, per em) to place words inside a merged run. */
function glyphWeight(ch: string): number {
  if (/\s/.test(ch)) return 0.278;
  if (/[0-9]/.test(ch)) return 0.556;
  if (/[.,:;'|!]/.test(ch)) return 0.278;
  if (/[-‐‑‒–—()/\\[\]]/.test(ch)) return 0.333;
  if (/[A-Z]/.test(ch)) return /[MW]/.test(ch) ? 0.833 : /[IJ]/.test(ch) ? 0.3 : 0.667;
  if (/[a-z]/.test(ch)) return /[mw]/.test(ch) ? 0.778 : /[ijlft]/.test(ch) ? 0.278 : 0.53;
  return 0.556;
}

/**
 * pdf.js merges text that shares a baseline into one run, even across table
 * cells ("1234.50 02" is an amount followed by the next cell's day). Each
 * word becomes its own item, positioned by its share of the run's width.
 */
export function splitRun(it: PdfItem): PdfItem[] {
  // A digit directly followed by a capitalised word ("…-9Amount") is two cells with no space.
  // The inserted break is a zero-width separator, so it takes no share of the run's width.
  const text = it.str.replace(/(?<=\d)(?=[A-Z][a-z])/g, "\u0000");
  if (!/[\s\u0000]/.test(text)) return [it];
  const chars = [...text];
  const weights = chars.map((ch) => (ch === "\u0000" ? 0 : glyphWeight(ch)));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const out: PdfItem[] = [];
  let pos = 0;
  let i = 0;
  while (i < chars.length) {
    if (/[\s\u0000]/.test(chars[i]!)) {
      pos += weights[i]!;
      i++;
      continue;
    }
    const start = pos;
    let word = "";
    while (i < chars.length && !/[\s\u0000]/.test(chars[i]!)) {
      word += chars[i];
      pos += weights[i]!;
      i++;
    }
    out.push({
      str: word,
      x: it.x + (it.w * start) / total,
      y: it.y,
      w: (it.w * (pos - start)) / total,
    });
  }
  return out;
}

/**
 * Where column i-1 ends and column i begins, searched between the two header
 * spans. Headers are centred while data is set against a cell's left edge,
 * so header centres alone put the first words of a wide column into its left
 * neighbour. Instead:
 * 1. The anchor is where the most cells start (words after a gap wider than
 *    a word space): a column's left edge. Ties go to the leftmost.
 * 2. The boundary is the middle of the least-straddled stretch within a few
 *    points to the left of the anchor.
 * With no word starting between the headers (an empty column), the boundary
 * is the middle of the longest least-straddled stretch.
 */
export function gutterBetween(
  left: number,
  right: number,
  words: PdfItem[],
  /** Words that follow a gap wider than a word space on their line (possible cell starts). */
  cellStarts: ReadonlySet<PdfItem> = new Set(words),
  /** Right edge of the next column's header, when known. */
  nextRight?: number,
): number {
  if (!(right > left + 0.5)) return (left + right) / 2;
  const step = 0.25;
  const covering = words.filter((w) => w.x < right && w.x + w.w > left);
  const xs: number[] = [];
  for (let x = left; x <= right + 1e-9; x += step) xs.push(x);
  const counts = xs.map((x) => covering.filter((w) => w.x < x && w.x + w.w > x).length);
  const min = Math.min(...counts);
  const zoneAround = (i: number): [number, number] => {
    let a = i;
    let b = i;
    while (a > 0 && counts[a - 1] === min) a--;
    while (b + 1 < counts.length && counts[b + 1] === min) b++;
    return [a, b];
  };

  const starts = new Map<number, number>();
  for (const w of covering)
    if (cellStarts.has(w) && w.x > left + 0.75 && w.x <= right + 0.5) {
      const bin = Math.round(w.x);
      starts.set(bin, (starts.get(bin) ?? 0) + 1);
    }
  const peak = [...starts.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0];
  // Right-aligned figures (amounts, share counts) start inside their own
  // header's span, so nothing of that column starts between the headers. A
  // few stray starts there (a PIN printed as its own run inside a long
  // address) must not become the column edge: when far more cells start
  // under the next header than at the best point between the headers, the
  // boundary is the emptiest stretch just before that header.
  if (nextRight !== undefined) {
    let inside = 0;
    for (const w of words) if (cellStarts.has(w) && w.x > right + 0.5 && w.x < nextRight) inside++;
    if (inside >= 20 && inside >= 4 * (peak?.[1] ?? 0)) {
      let b = counts.length - 1;
      while (b > 0 && counts[b] !== min) b--;
      let a = b;
      while (a > 0 && counts[a - 1] === min) a--;
      return (xs[a]! + xs[b]!) / 2;
    }
  }
  if (peak) {
    // The least-straddled stretch in the few points just left of the anchor.
    const hi = Math.min(xs.length - 1, Math.max(0, Math.floor((peak[0] - 0.75 - left) / step)));
    const lo = Math.max(0, hi - Math.round(6 / step));
    let localMin = Number.POSITIVE_INFINITY;
    for (let i = lo; i <= hi; i++) localMin = Math.min(localMin, counts[i]!);
    let b = hi;
    while (b > lo && counts[b] !== localMin) b--;
    let a = b;
    while (a > lo && counts[a - 1] === localMin) a--;
    return (xs[a]! + xs[b]!) / 2;
  }
  let best: [number, number] = [0, 0];
  for (let i = 0; i < counts.length;) {
    if (counts[i] !== min) {
      i++;
      continue;
    }
    const [a, b] = zoneAround(i);
    if (b - a > best[1] - best[0]) best = [a, b];
    i = b + 1;
  }
  return (xs[best[0]]! + xs[best[1]]!) / 2;
}

const hasDataDigits = (l: PdfLine) =>
  l.items.some((i) => /\d{4,}/.test(i.str) || /^[\d.,/-]+$/.test(i.str));
const HEADER_WORDS =
  /\b(investor|name|father|husband|folio|amount|date|transfer\w*|number|shares?|state|country|district|pin|address|type|investment|proposed|year|nature|client|dp|account|remarks|holder|nominee|pan|birth|iepf|of|to)\b/i;
const looksLikeHeader = (l: PdfLine) =>
  !hasDataDigits(l) && l.items.some((i) => HEADER_WORDS.test(i.str));

/**
 * PDF tables have no cells, only positioned text, and statutory statements
 * wrap both their headers ("Investor First" over "Name") and their records
 * (an address over two lines). So:
 * 1. Lines are rebuilt from text y positions, page by page.
 * 2. The header is the line naming the folio column plus the lines within a
 *    line-height of it; its words are grouped into columns where they overlap
 *    horizontally, and each column's words are read top to bottom.
 * 3. Runs that pdf.js merged across cells are split into words, and each
 *    word goes to the column whose left boundary (the emptiest gutter between
 *    two header spans) it starts after.
 * 4. A record starts on each line with text in the name column; lines with
 *    none (wrapped addresses, IDs) join the nearest record line.
 */
async function readPdf(buffer: Buffer): Promise<RawTable> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const lines: PdfLine[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const raw = (content.items as { str?: string; transform?: number[]; width?: number }[]).filter(
      (i) => i.str?.trim() && i.transform,
    );
    // Sideways tables (text rotated 90°) are turned back so rows run left to right.
    const vertical = raw.filter((i) => Math.abs(i.transform![1]!) > Math.abs(i.transform![0]!));
    const turn = vertical.length > raw.length / 2 ? Math.sign(vertical[0]!.transform![1]!) : 0;
    const items = raw.map((i) => {
      const [x, y] = [i.transform![4]!, i.transform![5]!];
      return {
        str: i.str!.trim(),
        x: turn > 0 ? y : turn < 0 ? -y : x,
        y: turn > 0 ? -x : turn < 0 ? x : y,
        w: i.width ?? 0,
      };
    });
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const pageLines: PdfLine[] = [];
    for (const it of items) {
      const line = pageLines.find((l) => Math.abs(l.y - it.y) <= 2.5);
      if (line) line.items.push(it);
      else pageLines.push({ y: it.y, page: p, items: [it] });
    }
    for (const l of pageLines) l.items.sort((a, b) => a.x - b.x);
    lines.push(...pageLines);
  }
  const pages = doc.numPages;
  await task.destroy();

  const headerIdx = lines.findIndex((l) => isHeaderRow(l.items.map((i) => i.str)));
  if (headerIdx < 0)
    throw new Error("No header row with a folio number column was found in the PDF.");
  const header = lines[headerIdx]!;
  // Headers wrap over up to four lines: chain outwards while lines stay close and hold no data.
  const headerLines = new Set<PdfLine>([header]);
  for (const step of [-1, 1]) {
    let prev = header;
    for (let i = headerIdx + step; Math.abs(i - headerIdx) <= 4; i += step) {
      const l = lines[i];
      if (!l || l.page !== header.page || Math.abs(l.y - prev.y) > 13 || !looksLikeHeader(l)) break;
      headerLines.add(l);
      prev = l;
    }
  }

  // 2. Columns from overlapping header words.
  const columns: Column[] = [];
  for (const it of [...headerLines].flatMap((l) => l.items).sort((a, b) => a.x - b.x)) {
    const col = columns.find((c) => it.x <= c.right + 1.5 && it.x + it.w >= c.left - 1.5);
    if (col) {
      col.items.push(it);
      col.left = Math.min(col.left, it.x);
      col.right = Math.max(col.right, it.x + it.w);
    } else columns.push({ left: it.x, right: it.x + it.w, items: [it] });
  }
  columns.sort((a, b) => a.left - b.left);
  const headers = columns.map((c) =>
    c.items
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((i) => i.str)
      .join(" ")
      // Words broken mid-way ("Investm ent", "transferr ed") are rejoined.
      .replace(/([a-z])- ?([a-z])/g, "$1$2"),
  );
  // Data words, split out of merged runs, decide where each column starts.
  // Each page repeats the header; every line of it, not just the folio line, is dropped.
  const lineText = (l: PdfLine) =>
    l.items
      .map((i) => i.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const headerTexts = new Set([...headerLines].map(lineText));
  // Where a later page repeats the header, whatever sits above it on that page
  // is page furniture (the statement's title, a letterhead), never a holder.
  const repeatedHeaderY = new Map<number, number>();
  for (const l of lines.slice(headerIdx + 1))
    if (isHeaderRow(l.items.map((i) => i.str)))
      repeatedHeaderY.set(l.page, Math.max(repeatedHeaderY.get(l.page) ?? -Infinity, l.y));
  const dataLines = lines
    .slice(headerIdx + 1)
    .filter(
      (l) =>
        !headerLines.has(l) &&
        !isHeaderRow(l.items.map((i) => i.str)) &&
        !headerTexts.has(lineText(l)) &&
        !(l.page !== header.page && l.y > (repeatedHeaderY.get(l.page) ?? Infinity)),
    );
  for (const l of dataLines) l.items = l.items.flatMap(splitRun).sort((a, b) => a.x - b.x);
  const words = dataLines.flatMap((l) => l.items);
  // A word space is about half a character; a cell starts after a wider gap.
  const charWidths = words
    .filter((w) => w.str.length > 1)
    .map((w) => w.w / w.str.length)
    .sort((a, b) => a - b);
  const medianChar = charWidths[Math.floor(charWidths.length / 2)] ?? 2.5;
  const cellStarts = new Set<PdfItem>();
  for (const l of dataLines)
    l.items.forEach((w, i) => {
      const prev = l.items[i - 1];
      if (!prev || w.x - (prev.x + prev.w) > medianChar * 0.6) cellStarts.add(w);
    });
  const bounds = columns.map((col, i) =>
    i === 0
      ? Number.NEGATIVE_INFINITY
      : gutterBetween(columns[i - 1]!.right, col.left, words, cellStarts, col.right),
  );
  const columnOf = (it: PdfItem) => {
    // A word belongs to the column whose left boundary it starts after.
    const start = it.x + 0.5;
    for (let i = bounds.length - 1; i >= 0; i--) if (start >= bounds[i]!) return i;
    return 0;
  };

  // The record key: the leftmost name column (or the folio column).
  const keyCol = (() => {
    const named = headers.findIndex((h) =>
      /first ?name|investor ?name|shareholder ?name|^name/i.test(h),
    );
    return named >= 0 ? named : headers.findIndex((h) => /folio/i.test(h));
  })();

  // 3–4. Data lines into records.
  const folioCol = headers.findIndex((h) => /folio/i.test(h));
  const assigned = dataLines.map((l) => ({ line: l, cells: new Map<number, PdfItem[]>() }));
  for (const a of assigned) {
    for (const it of a.line.items) {
      const c = columnOf(it);
      a.cells.set(c, [...(a.cells.get(c) ?? []), it]);
    }
    // pdf.js runs a demat ID and the holder's first name together
    // ("IN30039416 MATAPRASAD"); a word of letters after the ID is the name's.
    const ids = a.cells.get(folioCol);
    const next = folioCol + 1;
    if (folioCol >= 0 && ids && next < headers.length && /name/i.test(headers[next]!)) {
      const firstId = ids.findIndex((i) => /\d/.test(i.str));
      const moved = ids.filter(
        (i, k) => k > firstId && firstId >= 0 && /^[A-Za-z][A-Za-z.']*$/.test(i.str),
      );
      if (moved.length) {
        a.cells.set(
          folioCol,
          ids.filter((i) => !moved.includes(i)),
        );
        a.cells.set(
          next,
          [...moved, ...(a.cells.get(next) ?? [])].sort((x, y) => x.x - y.x),
        );
      }
    }
  }
  // A record starts with a name, or with its own folio (holders listed with a surname only).
  // A holder's first line carries its folio, amount or share count (a demat ID may
  // be centred lower in the cell, so it does not count).
  const idCols = headers
    .map((h, i) => (/folio|amount|shares/i.test(h) ? i : -1))
    .filter((i) => i >= 0);
  const hasId = (a: (typeof assigned)[number]) =>
    idCols.some((c) => (a.cells.get(c) ?? []).some((i) => /\d/.test(i.str)));
  const startSet = new Set<(typeof assigned)[number]>();
  const wrappedName = new Set<(typeof assigned)[number]>();
  const continuedName = new Set<(typeof assigned)[number]>();
  // Folio-led layouts (the folio is the first column and every holder's first
  // line carries its folio and amount together) wrap name, address and even
  // demat IDs onto lines with no amount: "IN30001110" over "430949" is one
  // 16-character demat account. There, a line without a figure is never a
  // new holder, unless it carries a folio of its own.
  const figureCols = headers
    .map((h, i) => (/amount|shares/i.test(h) ? i : -1))
    .filter((i) => i >= 0);
  const hasFigure = (a: (typeof assigned)[number]) =>
    figureCols.some((c) => (a.cells.get(c) ?? []).some((i) => /\d/.test(i.str)));
  const folioText = (a: (typeof assigned)[number]) =>
    (a.cells.get(folioCol) ?? [])
      .map((i) => i.str)
      .join("")
      .replace(/\s+/g, "");
  const withFigure = assigned.filter(hasFigure);
  const folioLed =
    folioCol === 0 &&
    figureCols.length > 0 &&
    withFigure.length >= 20 &&
    withFigure.filter((a) => /\d/.test(folioText(a))).length >= 0.95 * withFigure.length;
  /** The rest of a demat ID whose first part is on the holder's line above. */
  const continuesDemat = (prev: (typeof assigned)[number], cur: (typeof assigned)[number]) => {
    const head = folioText(prev);
    const tail = folioText(cur);
    return (
      /^\d+$/.test(tail) &&
      head.length + tail.length === 16 &&
      (/^IN[0-9A-Z]+$/i.test(head) || (/^\d+$/.test(head) && head.length >= 8))
    );
  };
  let prevStart: (typeof assigned)[number] | null = null;
  for (const a of assigned) {
    const folioStart = folioCol >= 0 && (a.cells.get(folioCol) ?? []).some((i) => /\d/.test(i.str));
    let start = a.cells.has(keyCol) || folioStart;
    if (start && folioLed && !hasFigure(a)) {
      const ownFolio =
        folioStart &&
        !(prevStart && prevStart.line.page === a.line.page && continuesDemat(prevStart, a));
      if (!ownFolio) {
        start = false;
        if (a.cells.has(keyCol)) continuedName.add(a);
      }
    }
    // A name fragment with no identifier just under a holder's first line is
    // that holder's name wrapping inside its cell, not another holder.
    if (
      start &&
      !folioStart &&
      !hasId(a) &&
      prevStart &&
      prevStart.line.page === a.line.page &&
      hasId(prevStart) &&
      prevStart.line.y - a.line.y > 0 &&
      prevStart.line.y - a.line.y <= 7
    ) {
      start = false;
      wrappedName.add(a);
    }
    if (start) {
      startSet.add(a);
      prevStart = a;
    }
  }
  const starts = assigned.filter((a) => startSet.has(a));
  const members = new Map(starts.map((s) => [s, [s]]));
  // A continuation line belongs to the record that started above it, except a
  // line sitting just over the next record's first line (a top-wrapped cell).
  for (const a of assigned) {
    if (members.has(a)) continue;
    const samePage = starts.filter((s) => s.line.page === a.line.page);
    const below = samePage
      .filter((s) => s.line.y < a.line.y)
      .sort((x, y) => y.line.y - x.line.y)[0];
    const above = samePage
      .filter((s) => s.line.y > a.line.y)
      .sort((x, y) => x.line.y - y.line.y)[0];
    // A line whose cells the record above already has, and the record below
    // lacks, is the top line of the record below (amounts set above the name).
    const fills = [...a.cells.keys()].filter((c) => c !== keyCol);
    const topOfBelow =
      !!below &&
      !!above &&
      a.line.y - below.line.y <= 13 &&
      fills.length > 0 &&
      fills.every((c) => above.cells.has(c) && !below.cells.has(c));
    const target = below && (a.line.y - below.line.y <= 4 || topOfBelow) ? below : (above ?? below);
    if (target && Math.abs(target.line.y - a.line.y) <= 80) members.get(target)!.push(a);
  }
  const notes = starts.map((s) => [
    ...(members.get(s)!.some((m) => wrappedName.has(m)) ? ["WRAPPED_NAME"] : []),
    ...(members.get(s)!.some((m) => continuedName.has(m)) ? ["NAME_CONTINUED"] : []),
  ]);
  const refs = starts.map((s) => `page ${s.line.page}, y ${Math.round(s.line.y)}`);
  const rows: unknown[][] = starts.map((s) => {
    const parts = members.get(s)!.sort((x, y) => y.line.y - x.line.y);
    return columns.map((_, c) =>
      parts
        .flatMap((p) => p.cells.get(c) ?? [])
        .map((i) => i.str)
        .join(" ")
        .replace(/(\d)- (\w)/g, "$1-$2")
        .trim(),
    );
  });
  // Fragments (wrapped text that formed its own line group) join the record above.
  const merged: string[][] = [];
  const mergedNotes: string[][] = [];
  const mergedRefs: string[] = [];
  (rows as string[][]).forEach((r, k) => {
    const fragment = folioCol >= 0 && !r[folioCol] && !r.some((c) => /\d{3,}/.test(c));
    if (fragment && merged.length) {
      const prev = merged[merged.length - 1]!;
      r.forEach((c, i) => {
        if (c) prev[i] = prev[i] ? `${prev[i]} ${c}` : c;
      });
      mergedNotes[mergedNotes.length - 1]!.push("MERGED_FRAGMENT", ...notes[k]!);
    } else {
      merged.push(r);
      mergedNotes.push([...notes[k]!]);
      mergedRefs.push(refs[k]!);
    }
  });
  return {
    headers,
    rows: merged,
    firstDataRow: 1,
    sheet: `pages 1-${pages}`,
    rowNotes: mergedNotes,
    rowRefs: mergedRefs,
  };
}

export async function readStatement(
  buffer: Buffer,
  fileName: string,
  contentType?: string | null,
): Promise<RawTable> {
  const format = formatOf(fileName, contentType);
  if (!format) throw new Error("Upload a .xlsx, .xls, .csv or .pdf statement.");
  return format === "pdf" ? readPdf(buffer) : readWorkbook(buffer, format);
}
