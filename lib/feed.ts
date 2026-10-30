// Real data feed for the stocks scanner.
// Sources (env var NAMES only — values are never logged, pasted, or
// hardcoded; they come from Vercel env vars at runtime):
//   FINNHUB_KEY, FMP_KEY, TWELVE_DATA_KEY
//
// Every fetch here FAILS SOFT: on a non-200 response, a 429 rate limit,
// a timeout, or an unparseable body, the function returns an empty
// result (or null) and the caller writes NO fake rows. A scan with no
// verified catalyst is recorded as an empty scan — that is correct.
// No retries: retrying a 429 only burns quota faster.
//
// Rate-limit reasoning (why the 15-minute scan is quote-only):
// Finnhub free is ~60 calls/minute. A 15-minute scan over 50 tickers
// already needs ~50 quote calls + 1 market-news call. Fetching company
// news AND candles for all 50 on every tick would be 150+ calls and
// would 429. So:
//  - /api/weekly (once a day): constituents + earnings + company news
//    for earnings tickers only + LLM sentiment in batches. General
//    market news is NOT used as a per-ticker catalyst: mapping one
//    broad headline to a whole sector (e.g. the same AI headline to
//    LMT, RTX and AMD) is copy-paste, not company evidence, so it was
//    removed — see buildCatalystEvents.
//  - /api/scan (every 15 min): quotes for the shortlist universe ONLY
//    (never all 500), + 1 market-news call filtered to that universe,
//    + the named catalyst already stored in weekly_shortlist. Fresh
//    company news / candles are fetched only for the single on-demand
//    ticker (?ticker=XYZ), never for the whole shortlist per tick.
//  - LLM sentiment is NEVER called in /api/scan. It is called in
//    /api/weekly, in batches of <=10 tickers (see lib/openrouter.ts),
//    and its result is stored in weekly_shortlist.reasoning as
//    "Sentiment (LLM): <label>, <score> — <reason>", which /api/scan
//    parses back out (parseStoredLlmSentiment). If that is absent,
//    /api/scan falls back to rule-based headline sentiment.

import type { CatalystEvent } from "@/lib/weekly";

// ---------------------------------------------------------------- types

export interface Constituent {
  ticker: string;
  company?: string;
  sector?: string;
  subSector?: string;
}

export interface ConstituentsResult {
  list: Constituent[];
  /** "fmp" when the live FMP list was used, "fallback" otherwise. */
  source: "fmp" | "fallback";
}

export interface EarningsEvent {
  symbol: string;
  date: string; // YYYY-MM-DD
  time?: string;
  epsEstimate?: number;
}

export interface NewsItem {
  headline: string;
  summary?: string;
  source?: string;
  url?: string;
  datetime?: number;
}

export interface Quote {
  ticker: string;
  price: number;
  changePct?: number; // 1-day % change, if the provider gave one
  prevClose?: number;
  source: "finnhub" | "twelvedata" | "fmp";
}

export interface CandleStats {
  change5dPct?: number;
  volumeRatio?: number; // last day volume / mean of prior days in window
}

// ------------------------------------------------------- fetch plumbing

// Diagnostics only: HTTP status per provider call, recorded here so
// /api/weekly can report WHY a feed returned nothing (401 = bad key,
// 402 = paid endpoint, 403 = plan, 429 = rate limit, timeout, etc).
// No key, URL, or body is ever recorded — only the status code/label.
export const feedDiagnostics: Record<string, string> = {};

function recordDiag(label: string, status: string) {
  feedDiagnostics[label] = status;
}

export async function fetchJson(
  url: string,
  timeoutMs = 8000,
  label?: string,
): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (label) recordDiag(label, String(res.status));
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    if (label) recordDiag(label, "timeout-or-network-error");
    return null;
  }
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Run fn over items with at most `limit` in flight at once. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ------------------------------------------------------------- fallback
//
// CACHED FALLBACK — NOT LIVE DATA. This list is used ONLY if the FMP
// constituents API fails, so the daily rebuild can still run against a
// known set of large, liquid names instead of failing entirely. Any
// run that uses it must be marked source="fallback" (see
// ConstituentsResult) and must NOT be presented as the live S&P 500
// list. It is deliberately small (~30 names) and will miss index
// changes until FMP recovers.
const FALLBACK_CONSTITUENTS: Constituent[] = [
  { ticker: "AAPL", company: "Apple Inc.", sector: "Information Technology" },
  { ticker: "MSFT", company: "Microsoft Corporation", sector: "Information Technology" },
  { ticker: "NVDA", company: "NVIDIA Corporation", sector: "Information Technology" },
  { ticker: "AMZN", company: "Amazon.com, Inc.", sector: "Consumer Discretionary" },
  { ticker: "GOOGL", company: "Alphabet Inc.", sector: "Communication Services" },
  { ticker: "META", company: "Meta Platforms, Inc.", sector: "Communication Services" },
  { ticker: "AVGO", company: "Broadcom Inc.", sector: "Information Technology", subSector: "Semiconductors" },
  { ticker: "AMD", company: "Advanced Micro Devices, Inc.", sector: "Information Technology", subSector: "Semiconductors" },
  { ticker: "TSLA", company: "Tesla, Inc.", sector: "Consumer Discretionary" },
  { ticker: "LLY", company: "Eli Lilly and Company", sector: "Health Care" },
  { ticker: "JPM", company: "JPMorgan Chase & Co.", sector: "Financials" },
  { ticker: "V", company: "Visa Inc.", sector: "Financials" },
  { ticker: "MA", company: "Mastercard Incorporated", sector: "Financials" },
  { ticker: "XOM", company: "Exxon Mobil Corporation", sector: "Energy" },
  { ticker: "CVX", company: "Chevron Corporation", sector: "Energy" },
  { ticker: "UNH", company: "UnitedHealth Group Incorporated", sector: "Health Care" },
  { ticker: "HD", company: "The Home Depot, Inc.", sector: "Consumer Discretionary" },
  { ticker: "PG", company: "Procter & Gamble Company", sector: "Consumer Staples" },
  { ticker: "COST", company: "Costco Wholesale Corporation", sector: "Consumer Staples" },
  { ticker: "WMT", company: "Walmart Inc.", sector: "Consumer Staples" },
  { ticker: "KO", company: "The Coca-Cola Company", sector: "Consumer Staples" },
  { ticker: "BA", company: "The Boeing Company", sector: "Industrials", subSector: "Aerospace & Defense" },
  { ticker: "LMT", company: "Lockheed Martin Corporation", sector: "Industrials", subSector: "Aerospace & Defense" },
  { ticker: "RTX", company: "RTX Corporation", sector: "Industrials", subSector: "Aerospace & Defense" },
  { ticker: "NOC", company: "Northrop Grumman Corporation", sector: "Industrials", subSector: "Aerospace & Defense" },
  { ticker: "INTC", company: "Intel Corporation", sector: "Information Technology", subSector: "Semiconductors" },
  { ticker: "NFLX", company: "Netflix, Inc.", sector: "Communication Services" },
  { ticker: "CRM", company: "Salesforce, Inc.", sector: "Information Technology" },
  { ticker: "ORCL", company: "Oracle Corporation", sector: "Information Technology" },
  { ticker: "DIS", company: "The Walt Disney Company", sector: "Communication Services" },
];

// ------------------------------------------------------------ constituents

export async function getSp500Constituents(): Promise<ConstituentsResult> {
  const key = process.env.FMP_KEY;
  if (key) {
    // FMP S&P 500 constituents: [{symbol, name, sector, subSector, ...}]
    // Try v3 first, then the newer stable endpoint (same shape, different
    // plan gating — free keys have been reported 402 on both, hence the
    // fallback below, but a paid key on either path works).
    const urls = [
      `https://financialmodelingprep.com/api/v3/sp500_constituent?apikey=${encodeURIComponent(key)}`,
      `https://financialmodelingprep.com/stable/sp500-constituent?apikey=${encodeURIComponent(key)}`,
    ];
    let data: unknown = null;
    for (const u of urls) {
      data = await fetchJson(u, 10000, "fmpConstituentsV3");
      if (Array.isArray(data) && data.length > 50) break;
    }
    if (Array.isArray(data) && data.length > 50) {
      const list: Constituent[] = [];
      for (const row of data) {
        const rec = asRecord(row);
        if (!rec) continue;
        const ticker = str(rec.symbol);
        if (!ticker) continue;
        list.push({
          ticker: ticker.toUpperCase(),
          company: str(rec.name),
          sector: str(rec.sector),
          subSector: str(rec.subSector),
        });
      }
      if (list.length > 50) return { list, source: "fmp" };
    }
  }
  // Live list unavailable — use the clearly-marked cached fallback.
  return { list: FALLBACK_CONSTITUENTS, source: "fallback" };
}

// --------------------------------------------------------------- earnings

export async function getEarningsCalendar(
  from: string,
  to: string,
): Promise<EarningsEvent[]> {
  const finnhubKey = process.env.FINNHUB_KEY;
  if (finnhubKey) {
    // Finnhub: {earningsCalendar: [{date, symbol, epsEstimate, ...}]}
    const data = await fetchJson(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${encodeURIComponent(finnhubKey)}`,
      10000, "finnhubEarnings",
    );
    const rec = asRecord(data);
    const cal = rec ? rec.earningsCalendar : null;
    if (Array.isArray(cal)) {
      const out: EarningsEvent[] = [];
      for (const row of cal) {
        const r = asRecord(row);
        if (!r) continue;
        const symbol = str(r.symbol);
        const date = str(r.date);
        if (!symbol || !date) continue;
        out.push({
          symbol: symbol.toUpperCase(),
          date,
          time: str(r.time),
          epsEstimate: num(r.epsEstimate),
        });
      }
      if (out.length > 0) return out;
    }
  }
  // Fallback: FMP earnings calendar for the same window.
  const fmpKey = process.env.FMP_KEY;
  if (fmpKey) {
    const data = await fetchJson(
      `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${encodeURIComponent(fmpKey)}`,
      10000, "fmpEarnings",
    );
    if (Array.isArray(data)) {
      const out: EarningsEvent[] = [];
      for (const row of data) {
        const r = asRecord(row);
        if (!r) continue;
        const symbol = str(r.symbol);
        const date = str(r.date);
        if (!symbol || !date) continue;
        out.push({ symbol: symbol.toUpperCase(), date, time: str(r.time) });
      }
      return out;
    }
  }
  return [];
}

// ------------------------------------------------------------------ news

export async function getCompanyNews(
  symbol: string,
  from: string,
  to: string,
): Promise<NewsItem[]> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return [];
  // Finnhub company news: [{headline, summary, source, url, datetime, ...}]
  const data = await fetchJson(
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
    8000, "finnhubCompanyNews",
  );
  if (!Array.isArray(data)) return [];
  const out: NewsItem[] = [];
  for (const row of data.slice(0, 10)) {
    const r = asRecord(row);
    if (!r) continue;
    const headline = str(r.headline);
    if (!headline) continue;
    out.push({
      headline,
      summary: str(r.summary),
      source: str(r.source),
      url: str(r.url),
      datetime: num(r.datetime),
    });
  }
  return out;
}

export async function getMarketNews(): Promise<NewsItem[]> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return [];
  // Finnhub general market news: [{headline, summary, source, url, ...}]
  const data = await fetchJson(
    `https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(key)}`,
    8000, "finnhubMarketNews",
  );
  if (!Array.isArray(data)) return [];
  const out: NewsItem[] = [];
  for (const row of data.slice(0, 50)) {
    const r = asRecord(row);
    if (!r) continue;
    const headline = str(r.headline);
    if (!headline) continue;
    out.push({
      headline,
      summary: str(r.summary),
      source: str(r.source),
      url: str(r.url),
      datetime: num(r.datetime),
    });
  }
  return out;
}

// ---------------------------------------------------------------- quotes

async function finnhubQuote(symbol: string): Promise<Quote | null> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  // Finnhub quote: {c: current, d: change, dp: % change, pc: prev close}
  const data = await fetchJson(
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
    6000,
  );
  const r = asRecord(data);
  const price = r ? num(r.c) : undefined;
  if (price === undefined || price <= 0) return null;
  return {
    ticker: symbol,
    price,
    changePct: num(r?.dp),
    prevClose: num(r?.pc),
    source: "finnhub",
  };
}

async function twelveDataQuote(symbol: string): Promise<Quote | null> {
  const key = process.env.TWELVE_DATA_KEY;
  if (!key) return null;
  // TwelveData quote: {close, percent_change, previous_close, ...}
  const data = await fetchJson(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
    6000,
  );
  const r = asRecord(data);
  const price = r ? num(r.close) ?? num(r.price) : undefined;
  if (price === undefined || price <= 0) return null;
  return {
    ticker: symbol,
    price,
    changePct: num(r?.percent_change),
    prevClose: num(r?.previous_close),
    source: "twelvedata",
  };
}

async function fmpQuote(symbol: string): Promise<Quote | null> {
  const key = process.env.FMP_KEY;
  if (!key) return null;
  // FMP quote: [{price, changesPercentage, previousClose, ...}]
  const data = await fetchJson(
    `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbol)}?apikey=${encodeURIComponent(key)}`,
    6000,
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = asRecord(data[0]);
  const price = r ? num(r.price) : undefined;
  if (price === undefined || price <= 0) return null;
  return {
    ticker: symbol,
    price,
    changePct: num(r?.changesPercentage),
    prevClose: num(r?.previousClose),
    source: "fmp",
  };
}

/** Quote with fallback chain: Finnhub -> TwelveData -> FMP. Null if all fail. */
export async function getQuote(symbol: string): Promise<Quote | null> {
  return (
    (await finnhubQuote(symbol)) ??
    (await twelveDataQuote(symbol)) ??
    (await fmpQuote(symbol))
  );
}

/** Quotes for a bounded universe only (the shortlist), concurrency-limited. */
export async function getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const results = await mapLimit(tickers, 8, (t) => getQuote(t));
  for (const q of results) {
    if (q) out.set(q.ticker, q);
  }
  return out;
}

/**
 * Daily candles for ONE ticker (on-demand only — never for all 50 per
 * tick). Used to compute a 5-day change and a volume ratio; null if
 * the provider fails, in which case the caller uses neutral values.
 */
export async function getCandleStats(symbol: string): Promise<CandleStats | null> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 14 * 24 * 3600;
  // Finnhub candles: {c: [closes], v: [volumes], t: [...], s: "ok"}
  const data = await fetchJson(
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
    8000,
  );
  const r = asRecord(data);
  if (!r || r.s !== "ok" || !Array.isArray(r.c) || r.c.length < 6) return null;
  const closes = (r.c as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined);
  if (closes.length < 6) return null;
  const last = closes[closes.length - 1];
  const fiveAgo = closes[closes.length - 6];
  const change5dPct = fiveAgo > 0 ? ((last - fiveAgo) / fiveAgo) * 100 : undefined;
  let volumeRatio: number | undefined;
  if (Array.isArray(r.v) && r.v.length === closes.length) {
    const vols = (r.v as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined);
    if (vols.length >= 6) {
      const prior = vols.slice(0, -1);
      const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (avg > 0) volumeRatio = vols[vols.length - 1] / avg;
    }
  }
  return { change5dPct, volumeRatio };
}

/**
 * Monthly candlestick summary for ONE ticker, from daily candles over
 * the past ~35 calendar days. Reasoning-only, by design: it is stored
 * in weekly_shortlist.reasoning by /api/weekly and shown on the
 * leaderboard, but it does NOT change any score (technical, volume,
 * catalyst, sentiment all stay exactly as before).
 *
 * Factual summary only — no candlestick pattern names ("hammer",
 * "engulfing", …): those labels add false precision on noisy daily
 * data. What is reported: month return, up/down session count,
 * last-3-session move, price vs 20-day average, distance from the
 * month high, and volume vs its 20-day average. Returns null on any
 * provider failure or too few sessions — the caller then writes no
 * monthly line, never a fabricated one.
 */
export interface MonthlyCandleData {
  summary: string;
  sessions: number;
  lastClose: number;
  monthPct: number;
  change5dPct: number | null;
  // Simple 14-day RSI (average gain / average loss over the last 14
  // daily changes, not Wilder-smoothed). 0-100, null if too few data.
  rsi14: number | null;
  // Historical volatility proxy — NOT options implied volatility, which
  // the free feeds do not provide. Average and largest absolute daily
  // % move over the past month, in percent points.
  avgAbsDailyPct: number;
  maxAbsDailyPct: number;
  volumeRatio: number | null;
  vsAvg20Pct: number | null;
  belowHighPct: number | null;
  // Breakout flag: price above its 20-day average AND within 3% of the
  // month high. A flag, not a prediction.
  breakout: boolean;
}

function computeMonthlyCandleData(closes: number[], highs: number[], vols: number[]): MonthlyCandleData | null {
  if (closes.length < 10) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (first <= 0 || last <= 0) return null;
  const monthPct = ((last - first) / first) * 100;
  let up = 0;
  let down = 0;
  const dailyPct: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const p = ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100;
    dailyPct.push(p);
    if (p > 0) up++;
    else if (p < 0) down++;
  }
  const avgAbsDailyPct = dailyPct.reduce((a, p) => a + Math.abs(p), 0) / dailyPct.length;
  const maxAbsDailyPct = Math.max(...dailyPct.map((p) => Math.abs(p)));
  let rsi14: number | null = null;
  const changes = dailyPct.slice(-14);
  if (changes.length >= 14) {
    const gains = changes.filter((p) => p > 0);
    const losses = changes.filter((p) => p < 0).map((p) => -p);
    const avgGain = gains.reduce((a, b) => a + b, 0) / 14;
    const avgLoss = losses.reduce((a, b) => a + b, 0) / 14;
    rsi14 = avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  const last3Pct =
    closes.length >= 4
      ? ((last - closes[closes.length - 4]) / closes[closes.length - 4]) * 100
      : null;
  const window = closes.slice(-20);
  const avg20 = window.reduce((a, b) => a + b, 0) / window.length;
  const vsAvg20Pct = avg20 > 0 ? ((last - avg20) / avg20) * 100 : null;
  const monthHigh = highs.length === closes.length && highs.length > 0 ? Math.max(...highs) : Math.max(...closes);
  const belowHighPct = monthHigh > 0 ? ((last - monthHigh) / monthHigh) * 100 : null;
  let volumeRatio: number | null = null;
  let volumePart = "";
  if (vols.length === closes.length) {
    if (vols.length >= 11) {
      const prior = vols.slice(-21, -1);
      const avgVol = prior.reduce((a, b) => a + b, 0) / prior.length;
      if (avgVol > 0) {
        volumeRatio = vols[vols.length - 1] / avgVol;
        volumePart = `, volume ${volumeRatio.toFixed(1)}x 20-day average`;
      }
    }
  }
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const parts = [
    `Month (candles): ${fmt(monthPct)} over ${closes.length} sessions (${up} up / ${down} down)`,
    last3Pct !== null ? `last 3 sessions ${fmt(last3Pct)}` : null,
    vsAvg20Pct !== null ? `price ${fmt(vsAvg20Pct)} vs 20-day average` : null,
    belowHighPct !== null ? `${belowHighPct.toFixed(1)}% below month high` : null,
    rsi14 !== null ? `RSI(14) ${rsi14.toFixed(0)}` : null,
  ].filter((p): p is string => p !== null);
  const change5dPct =
    closes.length >= 6
      ? ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      : null;
  return {
    summary: `${parts.join(", ")}${volumePart}.`,
    sessions: closes.length,
    lastClose: last,
    monthPct,
    change5dPct,
    rsi14,
    avgAbsDailyPct,
    maxAbsDailyPct,
    volumeRatio,
    vsAvg20Pct,
    belowHighPct,
    breakout: (vsAvg20Pct ?? -999) > 0 && (belowHighPct ?? -999) >= -3,
  };
}

export async function getMonthlyCandleData(symbol: string): Promise<MonthlyCandleData | null> {
  // Finnhub first; on any failure (including a 429, which the weekly
  // run hits when it makes ~100+ Finnhub calls in one run against the
  // 60/min free limit) fall back to TwelveData time_series, a
  // different provider with a different quota. A ticker with no data
  // from either still returns null — never fabricated.
  const finnhubKey = process.env.FINNHUB_KEY;
  if (finnhubKey) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 35 * 24 * 3600;
    const data = await fetchJson(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(finnhubKey)}`,
      6000,
    );
    const r = asRecord(data);
    if (r && r.s === "ok" && Array.isArray(r.c)) {
      const closes = (r.c as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined);
      const highs = Array.isArray(r.h)
        ? (r.h as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined)
        : [];
      const vols = Array.isArray(r.v)
        ? (r.v as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined)
        : [];
      const out = computeMonthlyCandleData(closes, highs, vols);
      if (out) return out;
    }
  }
  const tdKey = process.env.TWELVE_DATA_KEY;
  if (tdKey) {
    const data = await fetchJson(
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=35&apikey=${encodeURIComponent(tdKey)}`,
      8000,
    );
    const r = asRecord(data);
    if (r && Array.isArray(r.values)) {
      const rows = (r.values as unknown[])
        .map((v) => asRecord(v))
        .filter((v): v is Record<string, unknown> => v !== null)
        .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
      const closes = rows.map((v) => num(v.close)).filter((v): v is number => v !== undefined);
      const highs = rows.map((v) => num(v.high)).filter((v): v is number => v !== undefined);
      const vols = rows.map((v) => num(v.volume)).filter((v): v is number => v !== undefined);
      const out = computeMonthlyCandleData(closes, highs, vols);
      if (out) return out;
    }
  }
  return null;
}

export async function getMonthlyCandleSummary(symbol: string): Promise<string | null> {
  const data = await getMonthlyCandleData(symbol);
  return data?.summary ?? null;
}

export interface EarningsHistory {
  beats: number;
  total: number;
  avgSurprisePct: number | null;
  latestSurprisePct: number | null;
  summary: string;
}

/**
 * Earnings surprise history from Finnhub /stock/earnings (last 4
 * reported quarters, fail-soft). A repeat beater is a different setup
 * from a first-time earnings bet, so this is stored in reasoning and
 * used as a small shortlist-score modifier in /api/weekly — never as
 * a standalone pick. Returns null on any provider failure.
 */
export async function getEarningsHistory(symbol: string): Promise<EarningsHistory | null> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return null;
  const data = await fetchJson(
    `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
    6000,
  );
  if (!Array.isArray(data) || data.length === 0) return null;
  const rows = data
    .filter((r) => typeof r === "object" && r !== null && typeof (r as any).actual === "number" && typeof (r as any).estimate === "number")
    .slice(0, 4) as Array<{ actual: number; estimate: number; surprisePercent?: number }>;
  if (rows.length === 0) return null;
  const surprises = rows
    .map((r) => (typeof r.surprisePercent === "number" ? r.surprisePercent : r.estimate !== 0 ? ((r.actual - r.estimate) / Math.abs(r.estimate)) * 100 : null))
    .filter((v): v is number => v !== null);
  if (surprises.length === 0) return null;
  const beats = surprises.filter((s) => s > 0).length;
  const avg = surprises.reduce((a, b) => a + b, 0) / surprises.length;
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  return {
    beats,
    total: surprises.length,
    avgSurprisePct: avg,
    latestSurprisePct: surprises[0],
    summary: `Earnings history: beat ${beats}/${surprises.length} quarters, avg surprise ${fmt(avg)}.`,
  };
}

export interface MacroEvent {
  date: string;
  event: string;
}

/**
 * Major US macro events in the coming 7 days, from Finnhub's economic
 * calendar, filtered by keyword (CPI, FOMC/Fed, jobs, GDP, retail).
 * Shown as a dashboard note only — macro moves whole sectors, it is
 * not mapped to a single ticker as a catalyst. Fail-soft: [] on error.
 */
export async function getMacroEvents(from: string, to: string): Promise<MacroEvent[]> {
  const key = process.env.FINNHUB_KEY;
  if (!key) return [];
  const data = await fetchJson(
    `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
    8000,
  );
  const r = asRecord(data);
  const list = r && Array.isArray(r.economicCalendar) ? r.economicCalendar : [];
  const keywords = ["cpi", "consumer price", "fomc", "federal reserve", "fed", "nonfarm", "non-farm", "employment", "jobless", "gdp", "retail sales", "pce"];
  const out: MacroEvent[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const country = String(item.country ?? "").toUpperCase();
    const event = String(item.event ?? "");
    if (country && country !== "US") continue;
    const low = event.toLowerCase();
    if (!keywords.some((k) => low.includes(k))) continue;
    const date = String(item.time ?? "").slice(0, 10) || from;
    if (!out.some((o) => o.date === date && o.event === event)) out.push({ date, event });
  }
  return out.slice(0, 20);
}

// -------------------------------------------------------------- sentiment

const POSITIVE_WORDS = [
  "beat", "beats", "record", "surge", "surges", "strong", "growth", "upgrade",
  "upgraded", "raise", "raises", "raised", "outlook", "profit", "gain", "gains",
  "approval", "approved", "contract", "deal", "launch", "expands", "expansion",
  "buyback", "dividend", "positive",
];
const NEGATIVE_WORDS = [
  "miss", "misses", "fall", "falls", "drop", "drops", "decline", "weak",
  "downgrade", "downgraded", "cut", "cuts", "loss", "losses", "lawsuit",
  "investigation", "recall", "delay", "negative", "warning", "layoff", "layoffs",
];

/** Rule-based headline sentiment, 0-100 (50 = neutral). Never invents news. */
export function ruleBasedSentimentScore(headlines: string[]): number {
  if (headlines.length === 0) return 50;
  let pos = 0;
  let neg = 0;
  for (const h of headlines) {
    const text = h.toLowerCase();
    for (const w of POSITIVE_WORDS) if (text.includes(w)) pos++;
    for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg++;
  }
  if (pos === 0 && neg === 0) return 50;
  const raw = 50 + (pos - neg) * 12;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Parse the LLM sentiment stored in weekly_shortlist.reasoning by
 * /api/weekly, format: "Sentiment (LLM): <label>, <score> — <reason>".
 * Returns a 0-100 score, or null if no stored LLM sentiment is present.
 */
export function parseStoredLlmSentiment(reasoning: string | null | undefined): number | null {
  if (!reasoning) return null;
  const m = reasoning.match(/Sentiment \(LLM\):\s*\w+,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const score = Number(m[1]);
  if (!Number.isFinite(score)) return null;
  return Math.round(((Math.max(-1, Math.min(1, score)) + 1) * 50) * 10) / 10;
}

// ------------------------------------------------------- catalyst building

function containsAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Build CatalystEvent[] from live feed data. Every event must be
 * about THAT ticker — no sector copy-paste:
 * - Earnings: from the earnings calendar, ticker must be a constituent.
 * - Guidance / product / regulatory: from THAT company's own news
 *   (Finnhub company-news), matched on headline keywords.
 * General market news is deliberately NOT mapped here. Previously a
 * single broad headline (e.g. one AI-market story) was fanned out to
 * every constituent in a matching sector — the same headline on LMT,
 * RTX, AMD, etc. — which reads as company news when it is not. A
 * broad theme is not a per-ticker catalyst, so it produces no events.
 * Events outside the coming 7 days are dropped by the caller (earnings
 * are already windowed; news events are dated today).
 */
export function buildCatalystEvents(args: {
  constituents: Constituent[];
  earnings: EarningsEvent[];
  companyNewsByTicker: Map<string, NewsItem[]>;
}): CatalystEvent[] {
  const { constituents, earnings, companyNewsByTicker } = args;
  const byTicker = new Map(constituents.map((c) => [c.ticker, c]));
  const events: CatalystEvent[] = [];
  const today = isoDate(new Date());

  for (const e of earnings) {
    const c = byTicker.get(e.symbol);
    if (!c) continue; // earnings outside the S&P 500 universe are ignored
    events.push({
      ticker: e.symbol,
      company: c.company,
      type: "earnings",
      eventDate: e.date,
      detail: `Earnings due ${e.date}${e.time ? ` (${e.time})` : ""}${e.epsEstimate !== undefined ? `, EPS estimate ${e.epsEstimate}` : ""}.`,
      impact: 80,
      certainty: 90,
      sources: "Finnhub earnings calendar",
    });
  }

  for (const [ticker, news] of companyNewsByTicker) {
    const c = byTicker.get(ticker);
    if (!c) continue;
    for (const item of news) {
      const text = `${item.headline} ${item.summary ?? ""}`;
      if (containsAny(text, ["guidance", "outlook", "forecast", "raises outlook", "lowers outlook"])) {
        events.push({
          ticker, company: c.company, type: "guidance", eventDate: today,
          detail: `Guidance/outlook news: ${item.headline}`,
          impact: 70, certainty: 75, sources: item.source ?? "Finnhub company news",
        });
      } else if (containsAny(text, ["fda approval", "approved", "launch", "launches", "unveils", "new product"])) {
        events.push({
          ticker, company: c.company, type: "product", eventDate: today,
          detail: `Product news: ${item.headline}`,
          impact: 65, certainty: 75, sources: item.source ?? "Finnhub company news",
        });
      } else if (containsAny(text, ["lawsuit", "settlement", "sec investigation", "investigation", "antitrust", "fine"])) {
        events.push({
          ticker, company: c.company, type: "regulatory", eventDate: today,
          detail: `Regulatory/legal news: ${item.headline}`,
          impact: 60, certainty: 70, sources: item.source ?? "Finnhub company news",
        });
      }
    }
  }

  return events;
}
