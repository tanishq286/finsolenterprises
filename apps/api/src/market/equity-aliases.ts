/**
 * Names people actually type for large Indian listings that neither the NSE
 * symbol nor the registered name contains ("SBI" is SBIN, "HUL" is Hindustan
 * Unilever, "L&T" is Larsen & Toubro). Each entry points at real NSE symbols;
 * search lists these first and then carries on with the normal directory match.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  SBI: ["SBIN"],
  STATEBANK: ["SBIN"],
  HUL: ["HINDUNILVR"],
  HLL: ["HINDUNILVR"],
  UNILEVER: ["HINDUNILVR"],
  RIL: ["RELIANCE"],
  LT: ["LT"],
  LARSEN: ["LT"],
  MM: ["M&M"],
  MAHINDRA: ["M&M"],
  HDFC: ["HDFCBANK"],
  ICICI: ["ICICIBANK"],
  KOTAK: ["KOTAKBANK"],
  AXIS: ["AXISBANK"],
  BOB: ["BANKBARODA"],
  AIRTEL: ["BHARTIARTL"],
  BHARTI: ["BHARTIARTL"],
  IOCL: ["IOC"],
  INDIANOIL: ["IOC"],
  HPCL: ["HINDPETRO"],
  LIC: ["LICI"],
  HCL: ["HCLTECH"],
  ULTRATECH: ["ULTRACEMCO"],
  EICHER: ["EICHERMOT"],
  HERO: ["HEROMOTOCO"],
  HEROHONDA: ["HEROMOTOCO"],
  PIDILITE: ["PIDILITIND"],
  DRREDDYS: ["DRREDDY"],
  REDDYS: ["DRREDDY"],
  BAJAJFINANCE: ["BAJFINANCE"],
  BAJAJAUTO: ["BAJAJ-AUTO"],
  TATAMOTORS: ["TMPV", "TMCV"],
  TELCO: ["TMPV", "TMCV"],
  TISCO: ["TATASTEEL"],
  ASIANPAINTS: ["ASIANPAINT"],
  INFOSYS: ["INFY"],
};

/**
 * Upper-case and keep letters and digits, so "L&T", "l & t", "M&M", "Dr. Reddy's"
 * and "Bajaj Finance" become LT, LT, MM, DRREDDYS and BAJAJFINANCE.
 */
export function aliasKey(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** NSE symbols a nickname stands for, or none. */
export function symbolsForAlias(q: string): readonly string[] {
  const key = aliasKey(q);
  return key ? (ALIASES[key] ?? []) : [];
}
