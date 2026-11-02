import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  REFERENCE_COMPANIES,
  CALCULATOR_STOCKS,
  spinOffsFor,
  verifiedActionsFor,
  type CorporateActionLike,
} from "@finsol/shared";

import { ENV, type Env } from "../config/env.js";
import { PrismaService } from "../common/prisma.service.js";
import { num } from "../common/serialize.js";
import { MARKET_USER_AGENT, YahooChartProvider } from "./quote-providers.js";

export interface EquityListing {
  symbol: string;
  name: string;
  exchange: "NSE" | "BSE";
  isin: string | null;
}

export interface EquityDetail extends EquityListing {
  price: number | null;
  /** When the exchange printed the price (provider timestamp), if known. */
  priceQuoteAt: string | null;
  /** When we fetched it. */
  priceRetrievedAt: string | null;
  /** @deprecated Same as priceRetrievedAt; kept for older clients. */
  priceUpdatedAt: string | null;
  priceSource: string | null;
  /** Set when the latest fetch failed and the price shown is the last one on record. */
  priceError: string | null;
  priceAttemptedAt: string | null;
  /** False when no bonus/split history could be loaded (shares cannot be adjusted). */
  actionsKnown: boolean;
  /** Bonuses and splits, oldest first. */
  actions: CorporateActionLike[];
  /** "verified": checked by hand against company filings; "exchange": the exchange split record. */
  actionsBasis: "verified" | "exchange";
  /** Cash dividends per share as paid on each ex-date (not adjusted), oldest first. */
  dividends: { exDate: string; amount: number }[];
  /** First date the bonus/split history is verified from; null when complete since 1980. */
  historyFrom: string | null;
  /** Demergers: shares of new companies holders received, with each one's latest price. */
  spinOffs: {
    recordDate: string;
    symbol: string | null;
    name: string;
    ratioFrom: number | null;
    ratioTo: number | null;
    source: string;
    note: string | null;
    price: number | null;
    priceQuoteAt: string | null;
    priceSource: string | null;
  }[];
}

/** A usable price: finite and positive, else null (never NaN, never 0). */
const realPrice = (p: unknown): number | null => {
  const n = typeof p === "number" ? p : Number(p);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** NSE's published equity lists; the ISIN sits in a different column in each. */
const NSE_LISTS = [
  { url: "https://archives.nseindia.com/content/equities/EQUITY_L.csv", isinCol: 6 },
  { url: "https://archives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv", isinCol: 5 },
];
const DAY_MS = 86_400_000;
const DETAIL_TTL_MS = 15 * 60_000;

/**
 * The calculator's equity universe and per-stock history.
 * - Directory: every NSE main-board and SME equity, from NSE's published
 *   lists, stored in listed_equities (refreshed daily); BSE-only listings
 *   are found through Yahoo Finance's search.
 * - History: prices, bonus/split events and dividends from Yahoo Finance's
 *   chart API. Where a stock's history was verified by hand (the company
 *   catalogue and the calculator examples), those events replace the
 *   exchange record, which misses some combined bonus-and-split events.
 */
@Injectable()
export class EquitiesService implements OnApplicationBootstrap {
  private readonly log = new Logger("Equities");
  private size = 0;
  private loadedAt = 0;
  private readonly details = new Map<string, { at: number; value: EquityDetail }>();
  private readonly yahoo = new YahooChartProvider();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Network lookups follow the market sync switch, so tests stay offline. */
  private get online() {
    return this.env.MARKET_SYNC_ENABLED;
  }

  onApplicationBootstrap() {
    if (this.online && !this.env.SERVERLESS) void this.loadNse();
  }

  /** Reloads the NSE directory now (the serverless daily cron). Returns the directory size. */
  async refreshDirectory(): Promise<number> {
    if (this.online) await this.loadNse();
    return this.directorySize;
  }

  /**
   * Refreshes listed_equities from NSE's main-board and SME (Emerge) lists.
   * BSE refuses automated requests that identify themselves honestly, so
   * BSE-only listings come from Yahoo Finance's search at query time.
   */
  private async loadNse() {
    const rows: { symbol: string; name: string; isin: string | null; series: string }[] = [];
    for (const { url, isinCol } of NSE_LISTS) {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": MARKET_USER_AGENT },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        for (const line of (await res.text()).trim().split(/\r?\n/).slice(1)) {
          const cells = line.split(",").map((c) => c.trim());
          const [symbol, name, series] = cells;
          if (symbol && name && series)
            rows.push({ symbol, name, series, isin: cells[isinCol] || null });
        }
      } catch (e) {
        this.log.warn(`NSE list ${url} unavailable: ${(e as Error).message}`);
      }
    }
    if (!rows.length) return;
    const db = this.prisma.client;
    await db.$transaction([
      db.listedEquity.deleteMany({ where: { exchange: "NSE" } }),
      db.listedEquity.createMany({
        data: rows.map((r) => ({ exchange: "NSE", ...r })),
        skipDuplicates: true,
      }),
    ]);
    this.loadedAt = Date.now();
    this.size = await db.listedEquity.count();
    this.log.log(`Loaded ${this.size} NSE equities (main board and SME).`);
  }

  /** Offline fallback: the stocks whose histories we hold. */
  private known(): EquityListing[] {
    return [
      ...REFERENCE_COMPANIES.filter((c) => c.tickerNse).map((c) => ({
        symbol: c.tickerNse!,
        name: c.name,
        exchange: "NSE" as const,
        isin: c.isin,
      })),
      ...CALCULATOR_STOCKS.map((c) => ({
        symbol: c.symbol,
        name: c.name,
        exchange: "NSE" as const,
        isin: null,
      })),
    ];
  }

  get directorySize(): number {
    return this.size || this.known().length;
  }

  private async fromDirectory(needle: string, limit: number): Promise<EquityListing[] | null> {
    if (!this.size) this.size = await this.prisma.client.listedEquity.count();
    if (!this.size) return null;
    const rows = await this.prisma.client.$queryRaw<
      { symbol: string; name: string; exchange: "NSE" | "BSE"; isin: string | null }[]
    >`
      SELECT symbol, name, exchange, isin FROM listed_equities
      WHERE ${needle} = '' OR upper(symbol) LIKE ${needle + "%"} OR name ILIKE ${"%" + needle + "%"}
         OR name % ${needle}
      ORDER BY (upper(symbol) = ${needle}) DESC, (upper(symbol) LIKE ${needle + "%"}) DESC,
               (upper(name) LIKE ${needle + "%"}) DESC, similarity(name, ${needle}) DESC, name
      LIMIT ${limit}`;
    return rows;
  }

  async search(q: string, limit = 12): Promise<EquityListing[]> {
    if (this.online && Date.now() - this.loadedAt > DAY_MS) await this.loadNse();
    const needle = q.trim().toUpperCase();
    const local = await this.fromDirectory(needle, limit);
    const scored =
      local ??
      this.known()
        .filter(
          (e) => !needle || e.symbol.includes(needle) || e.name.toUpperCase().includes(needle),
        )
        .slice(0, limit);
    if (scored.length >= limit || !this.online || !needle) return scored.slice(0, limit);
    // BSE-only listings: ask Yahoo Finance's search.
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`,
        { headers: { "user-agent": MARKET_USER_AGENT }, signal: AbortSignal.timeout(5000) },
      );
      const body = (await res.json()) as {
        quotes?: { symbol: string; longname?: string; shortname?: string; quoteType?: string }[];
      };
      const nseSymbols = new Set(scored.map((s) => s.symbol));
      const bse = (body.quotes ?? [])
        .filter((x) => x.quoteType === "EQUITY" && x.symbol.endsWith(".BO"))
        .map((x) => ({
          symbol: x.symbol.slice(0, -3),
          name: x.longname ?? x.shortname ?? x.symbol,
          exchange: "BSE" as const,
          isin: null,
        }))
        .filter((x) => !nseSymbols.has(x.symbol) && !scored.some((s) => s.name === x.name));
      return [...scored, ...bse].slice(0, limit);
    } catch {
      return scored.slice(0, limit);
    }
  }

  async detail(
    symbol: string,
    exchange: "NSE" | "BSE" = "NSE",
    opts: { fresh?: boolean } = {},
  ): Promise<EquityDetail> {
    const key = `${exchange}:${symbol.toUpperCase()}`;
    const cached = this.details.get(key);
    // "₹ Sync" asks for a fresh price, at most once a minute per stock.
    const ttl = opts.fresh ? 60_000 : DETAIL_TTL_MS;
    if (cached && Date.now() - cached.at < ttl) return cached.value;

    const verified = exchange === "NSE" ? verifiedActionsFor(symbol) : null;
    const company = await this.prisma.client.company.findFirst({
      where: exchange === "NSE" ? { tickerNse: symbol.toUpperCase() } : { tickerBse: symbol },
    });
    const listed = await this.prisma.client.listedEquity.findUnique({
      where: { exchange_symbol: { exchange, symbol: symbol.toUpperCase() } },
    });
    const listing = listed ?? this.known().find((e) => e.symbol === symbol.toUpperCase());

    const history = this.online
      ? await this.yahoo
          .history(`${symbol.toUpperCase()}.${exchange === "NSE" ? "NS" : "BO"}`)
          .catch(() => null)
      : null;
    // A listed equity stays usable when the live fetch fails: its last cached price is served.
    if (!history && !verified && !company && !listed)
      throw new NotFoundException("We could not find that equity. Check the name or symbol.");

    const exchangeActions: CorporateActionLike[] = (history?.splits ?? [])
      .filter((s) => s.numerator > 0 && s.denominator > 0)
      .map((s) => ({
        actionType: "SPLIT",
        exDate: s.exDate,
        ratioFrom: s.numerator,
        ratioTo: s.denominator,
        notes: `Shares × ${s.numerator / s.denominator} (bonus or split, exchange record)`,
        source: "Exchange split history (via Yahoo Finance)",
      }));
    const actions = verified?.actions ?? exchangeActions;

    // Yahoo scales past dividends down by its own later split ratios; scaling
    // back up by the same ratios gives what one share received on the day.
    const yahooFactorAfter = (date: string) =>
      (history?.splits ?? [])
        .filter((s) => s.exDate > date)
        .filter((s) => s.numerator > 0 && s.denominator > 0)
        .reduce((f, s) => f * (s.numerator / s.denominator), 1);
    const dividends = (history?.dividends ?? []).map((d) => ({
      exDate: d.exDate,
      amount: Math.round(d.adjustedAmount * yahooFactorAfter(d.exDate) * 10_000) / 10_000,
    }));

    // Last real price on record: the company's, else the last quote cached for this listing.
    const companyPrice = realPrice(
      company?.currentMarketPrice ? num(company.currentMarketPrice) : null,
    );
    const listedPrice = realPrice(listed?.lastPrice ? num(listed.lastPrice) : null);
    const stored =
      companyPrice !== null
        ? {
            price: companyPrice,
            quoteAt: company!.priceQuoteAt,
            fetchedAt: company!.priceUpdatedAt,
            source: company!.priceSource,
          }
        : listedPrice !== null
          ? {
              price: listedPrice,
              quoteAt: listed!.lastPriceQuoteAt,
              fetchedAt: listed!.lastPriceFetchedAt,
              source: listed!.lastPriceSource,
            }
          : null;
    const dbPrice = stored?.price ?? null;
    const fetchedAt = new Date();
    const fresh = realPrice(history?.price);
    // Every real quote is kept on the listing, so any equity can fall back to its last close.
    if (listed && fresh !== null)
      await this.prisma.client.listedEquity
        .update({
          where: { exchange_symbol: { exchange, symbol: listed.symbol } },
          data: {
            lastPrice: fresh,
            lastPriceQuoteAt: history?.tradedAt ?? null,
            lastPriceFetchedAt: fetchedAt,
            lastPriceSource: `Yahoo Finance (${exchange})`,
          },
        })
        .catch((e: Error) => this.log.warn(`Listing price cache failed: ${e.message}`));
    // One price per company everywhere: a fresh quote newer than the stored one is
    // written through, so the company page, calculator and PDF agree.
    if (company && fresh !== null) {
      const newer =
        !company.priceQuoteAt || !history?.tradedAt || history.tradedAt >= company.priceQuoteAt;
      if (newer)
        await this.prisma.client.company
          .update({
            where: { id: company.id },
            data: {
              currentMarketPrice: fresh,
              priceQuoteAt: history?.tradedAt ?? null,
              priceUpdatedAt: fetchedAt,
              priceAttemptedAt: fetchedAt,
              priceError: null,
              priceSource: `Yahoo Finance (${exchange})`,
            },
          })
          .catch((e: Error) => this.log.warn(`Price write-through failed: ${e.message}`));
    }
    const useFresh = fresh !== null;
    const value: EquityDetail = {
      symbol: symbol.toUpperCase(),
      name: verified?.name ?? company?.name ?? listing?.name ?? history?.name ?? symbol,
      exchange,
      isin: listing?.isin ?? null,
      // No invented fallback: a fresh quote, else the last real one on record, else unknown.
      price: fresh ?? dbPrice,
      priceQuoteAt: useFresh
        ? (history?.tradedAt?.toISOString() ?? null)
        : (stored?.quoteAt?.toISOString() ?? null),
      priceRetrievedAt: useFresh
        ? fetchedAt.toISOString()
        : (stored?.fetchedAt?.toISOString() ?? null),
      priceUpdatedAt: useFresh
        ? fetchedAt.toISOString()
        : (stored?.fetchedAt?.toISOString() ?? null),
      priceSource: useFresh ? `Yahoo Finance (${exchange})` : (stored?.source ?? null),
      // A fetch that failed while an older price exists makes that price stale.
      priceError: !useFresh && this.online ? "The latest price fetch failed." : null,
      priceAttemptedAt: fetchedAt.toISOString(),
      actions,
      actionsBasis: verified ? "verified" : "exchange",
      actionsKnown: !!verified || !!history,
      dividends: dividends.filter((d) => Number.isFinite(d.amount) && d.amount > 0),
      historyFrom: verified?.historyFrom ?? null,
      spinOffs: [],
    };
    // Demergers: the new companies' own prices (they have no demergers of their own here).
    if (exchange === "NSE")
      for (const so of spinOffsFor(symbol)) {
        const child = so.childSymbol
          ? await this.detail(so.childSymbol, "NSE", opts).catch(() => null)
          : null;
        value.spinOffs.push({
          recordDate: so.recordDate,
          symbol: so.childSymbol,
          name: child?.name ?? so.childName,
          ratioFrom: so.ratioFrom,
          ratioTo: so.ratioTo,
          source: so.source,
          note: so.note ?? null,
          price: child?.price ?? null,
          priceQuoteAt: child?.priceQuoteAt ?? null,
          priceSource: child?.priceSource ?? null,
        });
      }
    this.details.set(key, { at: Date.now(), value });
    return value;
  }
}
