/**
 * The company universe for the source register, from NSE's published lists:
 * current main-board and SME equities, delisted companies, and the name and
 * symbol change histories (for historical aliases). BSE's list endpoint
 * refuses automated requests and is recorded as a dependency.
 */
import { readFile } from "node:fs/promises";

import type pg from "pg";

import { politeGet } from "./http.js";

export const NSE_LISTS = {
  equity: "https://archives.nseindia.com/content/equities/EQUITY_L.csv",
  sme: "https://archives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv",
  delisted: "https://archives.nseindia.com/content/equities/delisted.csv",
  nameChange: "https://archives.nseindia.com/content/equities/namechange.csv",
  symbolChange: "https://archives.nseindia.com/content/equities/symbolchange.csv",
} as const;

/** Minimal CSV reader (quoted fields, commas inside quotes). */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) out.push(row);
  return out;
}

async function csv(url: string): Promise<string[][]> {
  const res = await politeGet(url, { timeoutMs: 60_000 });
  if (res.kind !== "ok")
    throw new Error(`${url}: ${res.kind}${"status" in res ? ` ${res.status}` : ""}`);
  return parseCsv(res.body.toString("utf8"));
}

const col = (header: string[], re: RegExp) =>
  header.findIndex((h) => re.test(h.replace(/\s+/g, " ").trim()));

export interface UniverseStats {
  current: number;
  sme: number;
  delisted: number;
  aliases: number;
  merged: number;
}

/** Loads or refreshes the register from NSE's lists. Idempotent. */
export async function loadUniverse(pool: pg.Pool): Promise<UniverseStats> {
  const stats: UniverseStats = { current: 0, sme: 0, delisted: 0, aliases: 0, merged: 0 };
  const upsert = async (r: {
    key: string;
    name: string;
    isin: string | null;
    symbol: string | null;
    status: string;
  }) => {
    await pool.query(
      `INSERT INTO source_register (company_key, name, isin, nse_symbol, listing_status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_key) DO UPDATE SET name = EXCLUDED.name, nse_symbol = EXCLUDED.nse_symbol,
         listing_status = EXCLUDED.listing_status, updated_at = now()`,
      [r.key, r.name, r.isin, r.symbol, r.status],
    );
  };

  for (const [list, field] of [
    [NSE_LISTS.equity, "current"],
    [NSE_LISTS.sme, "sme"],
  ] as const) {
    const [header, ...rows] = await csv(list);
    const sym = col(header!, /^symbol$/i);
    const name = col(header!, /name/i);
    const isin = col(header!, /isin/i);
    for (const r of rows) {
      const isinValue = r[isin]?.toUpperCase();
      if (!r[sym] || !r[name] || !isinValue?.startsWith("IN")) continue;
      await upsert({
        key: isinValue,
        name: r[name]!,
        isin: isinValue,
        symbol: r[sym]!,
        status: "LISTED",
      });
      stats[field]++;
    }
  }

  // Delisted companies carry no ISIN in NSE's list: keyed by their last NSE symbol.
  const [dh, ...drows] = await csv(NSE_LISTS.delisted);
  const dsym = col(dh!, /^symbol$/i);
  const dname = col(dh!, /^company/i);
  const dtype = col(dh!, /type/i);
  for (const r of drows) {
    if (!r[dsym] || !r[dname]) continue;
    const listed = await pool.query(
      `SELECT 1 FROM source_register WHERE nse_symbol = $1 AND listing_status = 'LISTED'`,
      [r[dsym]],
    );
    if (listed.rowCount) continue;
    const merged = /amalgam|merg|scheme of arrangement/i.test(r[dtype] ?? "");
    await upsert({
      key: `NSE:${r[dsym]}`,
      name: r[dname]!,
      isin: null,
      symbol: r[dsym]!,
      status: merged ? "MERGED" : "DELISTED",
    });
    stats.delisted++;
    if (merged) stats.merged++;
  }

  // Historical names and symbols, attached to the company's current symbol.
  const [sh, ...srows] = await csv(NSE_LISTS.symbolChange);
  const oldSym = col(sh!, /old symbol/i);
  const newSym = col(sh!, /new symbol/i);
  const renamedTo = new Map<string, string>();
  for (const r of srows) if (r[oldSym] && r[newSym]) renamedTo.set(r[oldSym]!, r[newSym]!);
  const current = (s: string) => {
    let x = s;
    for (let i = 0; i < 10 && renamedTo.has(x); i++) x = renamedTo.get(x)!;
    return x;
  };
  const aliases = new Map<string, Set<string>>();
  const add = (symbol: string, alias: string) => {
    const s = current(symbol);
    if (!aliases.has(s)) aliases.set(s, new Set());
    aliases.get(s)!.add(alias);
  };
  for (const r of srows) if (r[oldSym] && r[newSym]) add(r[newSym]!, `NSE symbol ${r[oldSym]}`);
  const [nh, ...nrows] = await csv(NSE_LISTS.nameChange);
  const nsym = col(nh!, /^symbol$/i);
  const oldName = col(nh!, /old name/i);
  for (const r of nrows) if (r[nsym] && r[oldName]) add(r[nsym]!, r[oldName]!);
  for (const [symbol, set] of aliases) {
    const res = await pool.query(
      `UPDATE source_register SET aliases = ARRAY(SELECT DISTINCT unnest(aliases || $2::text[])), updated_at = now()
        WHERE nse_symbol = $1`,
      [symbol, [...set]],
    );
    stats.aliases += res.rowCount ? set.size : 0;
  }
  return stats;
}

/**
 * Websites and investor pages from a reviewed seed file. Columns:
 * nse_symbol,website,ir_url,basis. Every URL in it was opened and checked to
 * name the company before it was added; the basis column says how.
 */
export async function applySeeds(pool: pg.Pool, path: string): Promise<number> {
  const [header, ...rows] = parseCsv(await readFile(path, "utf8"));
  const i = (re: RegExp) => col(header!, re);
  const [sym, site, ir, basis, registrar] = [
    i(/symbol/i),
    i(/^website$/i),
    i(/^ir_url$/i),
    i(/^basis$/i),
    i(/^registrar$/i),
  ];
  let n = 0;
  for (const r of rows) {
    if (!r[sym]) continue;
    const res = await pool.query(
      `UPDATE source_register SET website = COALESCE(NULLIF($2, ''), website),
              website_basis = CASE WHEN NULLIF($2, '') IS NOT NULL THEN $4 ELSE website_basis END,
              ir_url = COALESCE(NULLIF($3, ''), ir_url),
              ir_url_basis = CASE WHEN NULLIF($3, '') IS NOT NULL THEN $4 ELSE ir_url_basis END,
              registrar = COALESCE(NULLIF($5, ''), registrar), updated_at = now()
        WHERE nse_symbol = $1`,
      [
        r[sym],
        r[site] ?? "",
        r[ir] ?? "",
        r[basis] ?? "seed file",
        registrar >= 0 ? (r[registrar] ?? "") : "",
      ],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}
