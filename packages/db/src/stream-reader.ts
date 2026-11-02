import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { parse as parseCsv } from "csv-parse";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

import { formatOf, isHeaderRow } from "./statement-reader.js";

/**
 * Streams the rows of a statement spreadsheet without holding the file or
 * its rows in memory, for files too large for `readStatement`:
 *
 *   .xlsx / .xlsm  ExcelJS's streaming reader (SAX over the zip entries)
 *   .csv           csv-parse as a stream (quoted commas and line breaks)
 *   .xls           legacy BIFF has no streaming reader; it is read whole, which
 *                  is bounded because a BIFF sheet holds at most 65,536 rows
 *
 * Cells come out as the same primitives `readStatement` produces (strings,
 * numbers, Dates, null), so `parseRow` treats both paths alike. Blank rows
 * are skipped but keep their row numbers, so row references stay exact.
 */

/** Bumped when streamed extraction changes; stored with each source document. */
export const STREAM_PARSER_VERSION = "stream-reader/2026.11.3";

export interface StreamedRow {
  /** 1-based row number in the sheet (or line record in a CSV). */
  number: number;
  cells: unknown[];
}

export interface StreamedSheet {
  sheet: string;
  headers: string[];
  /** 1-based number of the header row. */
  headerRow: number;
  rows: AsyncGenerator<StreamedRow>;
}

/** Header rows are near the top; a sheet without one in its first rows is skipped. */
const HEADER_SCAN_ROWS = 60;

function cellValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText))
    return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("");
  if ("result" in o) return cellValue(o.result); // formula
  if ("text" in o) return cellValue(o.text); // hyperlink
  if ("error" in o) return null;
  return String(v);
}

const isBlank = (cells: unknown[]) =>
  cells.every((c) => c === null || c === undefined || String(c).trim() === "");

/** Merges a second header row ("Investor" / "First Name"), as `readStatement` does. */
function mergeHeaderRow(headers: string[], next: unknown[] | undefined): string[] | null {
  if (
    next &&
    next.some((c) => /name|number|date|amount/i.test(String(c ?? ""))) &&
    !next.some((c) => /\d{4,}/.test(String(c ?? "")))
  )
    return headers.map((h, i) => [h, String(next[i] ?? "").trim()].filter(Boolean).join(" "));
  return null;
}

/**
 * Finds the header row in the first rows of `source`, then yields the data
 * rows after it. Returns null when no header row is found.
 */
async function withHeader(
  sheet: string,
  source: AsyncIterator<StreamedRow>,
): Promise<StreamedSheet | null> {
  const head: StreamedRow[] = [];
  let found = -1;
  while (head.length < HEADER_SCAN_ROWS) {
    const n = await source.next();
    if (n.done) break;
    head.push(n.value);
    if (isHeaderRow(n.value.cells)) {
      found = head.length - 1;
      break;
    }
  }
  if (found < 0) {
    await source.return?.(undefined);
    return null;
  }
  const headerRow = head[found]!;
  let headers = headerRow.cells.map((c) => String(c ?? "").trim());
  // Peek at the next non-blank row for a two-row header.
  let pending: StreamedRow | null = null;
  for (;;) {
    const n = await source.next();
    if (n.done) break;
    if (isBlank(n.value.cells)) continue;
    pending = n.value;
    break;
  }
  const merged = mergeHeaderRow(headers, pending?.cells);
  if (merged) {
    headers = merged;
    pending = null;
  }
  async function* rows(): AsyncGenerator<StreamedRow> {
    if (pending) yield pending;
    for (;;) {
      const n = await source.next();
      if (n.done) return;
      if (!isBlank(n.value.cells)) yield n.value;
    }
  }
  return { sheet, headers, headerRow: headerRow.number, rows: rows() };
}

async function* xlsxSheets(
  path: string,
): AsyncGenerator<{ name: string; rows: AsyncIterator<StreamedRow> }> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    sharedStrings: "cache",
    hyperlinks: "cache",
    styles: "cache", // needed to tell dates from numbers
    worksheets: "emit",
    entries: "emit",
  });
  for await (const ws of reader) {
    const w = ws as unknown as AsyncIterable<ExcelJS.Row> & { name?: string; id?: number };
    async function* rows(): AsyncGenerator<StreamedRow> {
      for await (const row of w) {
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        yield { number: row.number, cells: values.map(cellValue) };
      }
    }
    yield { name: w.name ?? `Sheet ${w.id ?? ""}`.trim(), rows: rows() };
  }
}

async function* csvRows(path: string): AsyncGenerator<StreamedRow> {
  const parser = createReadStream(path).pipe(
    parseCsv({ bom: true, relax_column_count: true, relax_quotes: true, skip_empty_lines: false }),
  );
  let n = 0;
  for await (const record of parser as AsyncIterable<string[]>) {
    n++;
    yield { number: n, cells: record.map((c) => (c === "" ? null : c)) };
  }
}

async function* gridRows(grid: unknown[][]): AsyncGenerator<StreamedRow> {
  for (let i = 0; i < grid.length; i++) yield { number: i + 1, cells: grid[i] ?? [] };
}

/**
 * Opens the first sheet of `path` that has an IEPF header row (a folio or
 * DP ID-client ID column among short cells).
 */
export async function openStatementStream(path: string, fileName = path): Promise<StreamedSheet> {
  const format = formatOf(fileName) ?? (/\.xlsm$/i.test(fileName) ? "xlsx" : null);
  if (format === "xlsx") {
    for await (const s of xlsxSheets(path)) {
      const opened = await withHeader(s.name, s.rows);
      if (opened) return opened;
    }
  } else if (format === "csv") {
    const opened = await withHeader("csv", csvRows(path));
    if (opened) return opened;
  } else if (format === "xls") {
    const { size } = await stat(path);
    if (size > 200 * 1024 * 1024)
      throw new Error("A legacy .xls this large is not a valid BIFF workbook.");
    const wb = XLSX.read(await readFile(path), { type: "buffer", cellDates: true, dense: true });
    for (const name of wb.SheetNames) {
      const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, {
        header: 1,
        defval: null,
        blankrows: true,
        raw: true,
      });
      const opened = await withHeader(name, gridRows(grid));
      if (opened) return opened;
    }
  } else {
    throw new Error(
      "Streaming reads .xlsx, .xlsm, .xls and .csv statements; PDFs use readStatement.",
    );
  }
  throw new Error("No header row with a folio number or DP ID-client ID column was found.");
}

/** Groups a row stream into arrays of at most `size`. */
export async function* chunked<T>(rows: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let buf: T[] = [];
  for await (const r of rows) {
    buf.push(r);
    if (buf.length >= size) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}
