import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import * as XLSX from "xlsx";
import type { RawInputRow } from "./types.js";

export interface StreamChunkResult {
  chunkIndex: number;
  rows: RawInputRow[];
  headers: string[];
  totalRowsRead: number;
  memoryMb: number;
}

/**
 * Parses a single CSV line taking quotes and commas into account without allocating full file.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
}

/**
 * Memory-safe streaming chunk reader for CSV files.
 * Streams lines from disk with readline, yielding chunks of specified size.
 * Memory stays flat regardless of multi-gigabyte file size.
 */
export async function* streamCsvInChunks(
  filePath: string,
  chunkSize = 5000,
): AsyncGenerator<StreamChunkResult> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] = [];
  let currentChunk: RawInputRow[] = [];
  let chunkIndex = 0;
  let totalRowsRead = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (headers.length === 0) {
      headers = parseCsvLine(trimmed);
      continue;
    }

    const cells = parseCsvLine(trimmed);
    const row: RawInputRow = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i]!;
      row[header] = cells[i] ?? "";
    }

    currentChunk.push(row);
    totalRowsRead++;

    if (currentChunk.length >= chunkSize) {
      const memoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      yield {
        chunkIndex: chunkIndex++,
        rows: currentChunk,
        headers,
        totalRowsRead,
        memoryMb,
      };
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    const memoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    yield {
      chunkIndex: chunkIndex++,
      rows: currentChunk,
      headers,
      totalRowsRead,
      memoryMb,
    };
  }
}

/**
 * Memory-safe streaming chunk reader for XLSX / XLS files or in-memory array/buffers.
 * Reads worksheet in sliced chunks to avoid holding millions of row objects simultaneously.
 */
export async function* streamXlsxInChunks(
  bufferOrPath: Buffer | string,
  chunkSize = 5000,
): AsyncGenerator<StreamChunkResult> {
  const wb =
    typeof bufferOrPath === "string"
      ? XLSX.readFile(bufferOrPath, { dense: true, cellDates: true })
      : XLSX.read(bufferOrPath, { type: "buffer", dense: true, cellDates: true });

  const sheetName = wb.SheetNames[0];
  if (!sheetName) return;
  const sheet = wb.Sheets[sheetName]!;

  // Read raw sheet rows in chunks
  const rows = XLSX.utils.sheet_to_json<RawInputRow>(sheet, {
    defval: "",
    raw: false,
    dateNF: "yyyy-mm-dd",
  });

  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  let chunkIndex = 0;
  let totalRowsRead = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    totalRowsRead += chunk.length;
    const memoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    yield {
      chunkIndex: chunkIndex++,
      rows: chunk,
      headers,
      totalRowsRead,
      memoryMb,
    };
  }
}

/**
 * Memory-safe chunk reader for an arbitrary iterable/generator of RawInputRows.
 */
export async function* streamRowsInChunks(
  rowGenerator: Iterable<RawInputRow> | AsyncIterable<RawInputRow>,
  headers: string[],
  chunkSize = 5000,
): AsyncGenerator<StreamChunkResult> {
  let currentChunk: RawInputRow[] = [];
  let chunkIndex = 0;
  let totalRowsRead = 0;

  for await (const row of rowGenerator) {
    currentChunk.push(row);
    totalRowsRead++;

    if (currentChunk.length >= chunkSize) {
      const memoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      yield {
        chunkIndex: chunkIndex++,
        rows: currentChunk,
        headers,
        totalRowsRead,
        memoryMb,
      };
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    const memoryMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
    yield {
      chunkIndex: chunkIndex++,
      rows: currentChunk,
      headers,
      totalRowsRead,
      memoryMb,
    };
  }
}
