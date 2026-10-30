import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { confidenceFor, marketStatus, scoreCandidate } from "@/lib/scan";
import {
  addDays,
  getCandleStats,
  getCompanyNews,
  getEarningsCalendar,
  getMarketNews,
  getQuotes,
  getSp500Constituents,
  isoDate,
  parseStoredLlmSentiment,
  ruleBasedSentimentScore,
  type Quote,
} from "@/lib/feed";

// Triggered externally by cron-job.org every 15 minutes, 24/7.
// Vercel free tier does not allow 15-minute Vercel Cron, so the trigger
// lives outside Vercel. This route must stay fast (Hobby function limits).
//
// Two-stage design (free-tier workaround):
// - Stage 1 (/api/weekly, once a day) picks ~50 tickers with a real
//   catalyst this week: earnings/results, macro, geopolitical, sector.
// - Stage 2 (this route) scans ONLY those 50 every 15 minutes.
// - Anything outside the 50 is checked on demand, e.g. /api/scan?ticker=XYZ,
//   not on every 15-minute run. Do NOT run an LLM over all 500 tickers.
//
// Real feed (see lib/feed.ts): quotes for the universe only (Finnhub,
// falling back to TwelveData then FMP), 1 market-news call filtered to
// the universe, and the named catalyst stored in weekly_shortlist.
// LLM sentiment is NOT called here — it is stored in
// weekly_shortlist.reasoning by /api/weekly and parsed back out; if
// absent, rule-based headline sentiment is used. Volume and sector
// are neutral (50) when no verified data is available, rather than
// invented: the quote-only path has no volume ratio, and a sector
// score is only raised when sector news matches the ticker's sector.
// A candidate reaches the leaderboard ONLY with a named catalyst +
// reasoning. A scan with no verified candidates is recorded as an
// empty scan, so the frontend never shows invented picks.
//
// Security: cron-job.org must send Authorization: Bearer <CRON_SECRET>.
// Without it, anyone who finds the URL could spam your Neon database.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ShortlistRow {
  ticker: string;
  company: string | null;
  catalyst_type: string;
  event_detail: string;
  reasoning: string;
  score: number;
  // Numeric weekly candle/sector data, when the latest shortlist was
  // built by the new weekly code. Older rows have nulls, and the
  // scoring below falls back to the old neutral values.
  rsi14?: number | null;
  month_pct?: number | null;
  volume_ratio?: number | null;
  change_5d_pct?: number | null;
  sector_rel_pct?: number | null;
  avg_abs_daily_pct?: number | null;
  event_date?: string | null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sql = neon(process.env.DATABASE_URL!);
  const status = marketStatus();
  const now = new Date().toISOString();

  // Universe for THIS run — never all 500 on a 15-minute tick:
  // - ?ticker=XYZ  -> on-demand single ticker, outside the shortlist
  // - otherwise    -> latest weekly_shortlist, capped at 50
  const onDemand = req.nextUrl.searchParams.get("ticker")?.toUpperCase() ?? null;
  let universe: string[] = [];
  let mode = "shortlist";
  // Shortlist rows carry the named catalyst + stored LLM sentiment.
  const shortlistByTicker = new Map<string, ShortlistRow>();
  if (onDemand) {
    universe = [onDemand];
    mode = "on_demand";
  } else {
    try {
      // New columns (rsi14, month_pct, ...) exist only after a weekly
      // rebuild that ran ALTER TABLE. Until then, fall back to the
      // old column list so scans keep working instead of emptying.
      let shortlist: unknown[];
      try {
        shortlist = await sql`
          SELECT ticker, company, catalyst_type, event_detail, reasoning, score,
                 rsi14, month_pct, volume_ratio, change_5d_pct, sector_rel_pct,
                 avg_abs_daily_pct, event_date
          FROM weekly_shortlist
          WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
          ORDER BY score DESC LIMIT 50
        `;
      } catch {
        shortlist = await sql`
          SELECT ticker, company, catalyst_type, event_detail, reasoning, score
          FROM weekly_shortlist
          WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
          ORDER BY score DESC LIMIT 50
        `;
      }
      for (const row of shortlist as unknown as ShortlistRow[]) {
        shortlistByTicker.set(row.ticker, row);
      }
      universe = [...shortlistByTicker.keys()];
    } catch {
      // weekly_shortlist not created / no daily run yet: scan nothing
      // rather than falling back to all 500 and timing out.
      universe = [];
    }
  }

  // Company/sector lookup for the universe only (1 FMP call, fail-soft).
  const constituents = (await getSp500Constituents()).list;
  const constituentByTicker = new Map(constituents.map((c) => [c.ticker, c]));

  // Quotes for the universe ONLY, with provider fallback inside getQuote.
  // A ticker with no quote is skipped — never scored on a stale price.
  const quotes = await getQuotes(universe);
  // One market-news call, filtered to universe tickers by company name.
  const marketNews = universe.length > 0 ? await getMarketNews() : [];

  // On-demand only: fresh company news + earnings + candles for the
  // single ticker. This is the only path that fetches per-ticker news
  // or candles on a scan tick, and it is bounded to 1 ticker.
  let onDemandCatalyst: ShortlistRow | null = null;
  let onDemandNewsHeadlines: string[] = [];
  let onDemandCandle: { change5dPct?: number; volumeRatio?: number } | null = null;
  if (onDemand) {
    const today = isoDate(new Date());
    const earnings = await getEarningsCalendar(today, isoDate(addDays(new Date(), 7)));
    const earning = earnings.find((e) => e.symbol === onDemand);
    const news = await getCompanyNews(onDemand, isoDate(addDays(new Date(), -3)), today);
    onDemandNewsHeadlines = news.map((n) => n.headline);
    onDemandCandle = await getCandleStats(onDemand);
    if (earning) {
      onDemandCatalyst = {
        ticker: onDemand,
        company: constituentByTicker.get(onDemand)?.company ?? null,
        catalyst_type: "earnings",
        event_detail: `Earnings due ${earning.date}.`,
        reasoning: `Earnings due ${earning.date}.`,
        score: 80,
      };
    } else {
      // News alone is not a catalyst: only keyword-matched guidance /
      // product / regulatory news counts, otherwise no row, by design.
      const text = news.length > 0 ? `${news[0].headline} ${news[0].summary ?? ""}`.toLowerCase() : "";
      const kind =
        text.includes("guidance") || text.includes("outlook") || text.includes("forecast")
          ? "guidance"
          : text.includes("launch") || text.includes("approval") || text.includes("approved") || text.includes("unveils")
            ? "product"
            : text.includes("lawsuit") || text.includes("settlement") || text.includes("investigation") || text.includes("antitrust")
              ? "regulatory"
              : null;
      if (kind && news.length > 0) {
        onDemandCatalyst = {
          ticker: onDemand,
          company: constituentByTicker.get(onDemand)?.company ?? null,
          catalyst_type: kind,
          event_detail: `Recent news: ${news[0].headline}`,
          reasoning: `Recent news: ${news[0].headline}`,
          score: 60,
        };
      }
    }
    // No earnings and no keyword-matched news -> no named catalyst -> no row.
  }

  let llmSentimentUsed = 0;
  const candidates: Array<{
    ticker: string;
    technical: number;
    catalyst: number;
    sentiment: number;
    volume: number;
    sector: number;
    reasoning: string;
    catalystLabel?: string;
    sentimentLabel?: string;
    price?: number;
    change1dPct?: number;
    change5dPct?: number;
    volumeRatio?: number;
    company?: string;
    sources?: string;
  }> = [];

  for (const ticker of universe) {
    const quote: Quote | undefined = quotes.get(ticker);
    if (!quote) continue; // no verified price -> no row, never a stale one

    const shortlist = shortlistByTicker.get(ticker);
    const catalystRow = mode === "on_demand" ? onDemandCatalyst : shortlist;
    if (!catalystRow) continue; // no named catalyst -> no row, by design
    if (!catalystRow.event_detail) continue;

    const constituent = constituentByTicker.get(ticker);
    const company = catalystRow.company ?? constituent?.company ?? undefined;

    // Headlines about this ticker: market news mentioning its company
    // name, plus (on-demand only) its own company news.
    const headlines: string[] = [];
    if (company) {
      const name = company.toLowerCase();
      // Match on a distinctive word of the company name (e.g. "Apple"
      // from "Apple Inc.") so generic words do not false-match.
      const distinctive = name
        .replace(/\b(inc\.?|corp\.?|corporation|company|ltd\.?|plc)\b/g, "")
        .trim()
        .split(/\s+/)[0];
      if (distinctive && distinctive.length >= 3) {
        for (const item of marketNews) {
          const text = `${item.headline} ${item.summary ?? ""}`.toLowerCase();
          if (text.includes(distinctive)) headlines.push(item.headline);
        }
      }
    }
    if (mode === "on_demand") headlines.push(...onDemandNewsHeadlines);

    // Technical, now real multi-day data when the latest shortlist
    // carries it (from tomorrow's weekly rebuild onward):
    // 40% 1-day move + 25% month move + 15% RSI score (RSI near 60 is
    // strongest; very overbought/oversold are penalised) + 20%
    // volatility score. Volatility matters for a 5% target: a stock
    // that normally moves 3% a day is far more likely to reach +5%
    // in a week than one that moves 0.8%. volScore maps average
    // absolute daily move (avg_abs_daily_pct, already stored by
    // weekly) 1% -> 40, 2% -> 50, 3% -> 60, 4% -> 70, 5%+ -> 80.
    // Without monthly data, falls back to the old 1-day-only formula.
    const change1dPct = quote.changePct;
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const technical1d =
      change1dPct === undefined ? 50 : clamp(50 + change1dPct * 10);
    let technical = technical1d;
    const m = mode === "on_demand" ? null : shortlist;
    let volScore: number | null = null;
    if (m && m.month_pct !== null && m.month_pct !== undefined) {
      const technicalMonth = clamp(50 + Number(m.month_pct) * 3);
      const rsi = m.rsi14 !== null && m.rsi14 !== undefined ? Number(m.rsi14) : null;
      const rsiScore = rsi === null ? 50 : clamp(100 - Math.abs(rsi - 60) * 1.5);
      const avgAbs = m.avg_abs_daily_pct !== null && m.avg_abs_daily_pct !== undefined ? Number(m.avg_abs_daily_pct) : null;
      volScore = avgAbs === null ? 50 : Math.max(20, Math.min(85, 30 + avgAbs * 10));
      technical = 0.4 * technical1d + 0.25 * technicalMonth + 0.15 * rsiScore + 0.2 * volScore;
    }

    // Earnings proximity: a catalyst that fires sooner is more
    // likely to move the price inside the 1-week horizon, so an
    // earnings catalyst within 7 days gets a small bonus (<=2 days
    // +10, <=4 days +7, <=7 days +4), capped at 100. This does not
    // create a catalyst — only earnings rows already on the board
    // get it, and non-earnings catalysts get nothing.
    let catalystScore = catalystRow.score;
    let daysToEvent: number | null = null;
    if (m && catalystRow.catalyst_type === "earnings" && m.event_date) {
      const ev = Date.parse(`${String(m.event_date).slice(0, 10)}T00:00:00Z`);
      if (Number.isFinite(ev)) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        daysToEvent = Math.round((ev - today.getTime()) / (24 * 3600 * 1000));
        if (daysToEvent >= 0 && daysToEvent <= 2) catalystScore = Math.min(100, catalystScore + 10);
        else if (daysToEvent <= 4) catalystScore = Math.min(100, catalystScore + 7);
        else if (daysToEvent <= 7) catalystScore = Math.min(100, catalystScore + 4);
      }
    }

    // Sentiment: stored LLM sentiment first, else rule-based headlines.
    const storedLlm = parseStoredLlmSentiment(catalystRow.reasoning);
    let sentiment: number;
    let sentimentLabel: string;
    if (storedLlm !== null) {
      sentiment = storedLlm;
      sentimentLabel =
        storedLlm >= 75 ? "positive" : storedLlm <= 25 ? "negative" : "neutral";
      llmSentimentUsed++;
    } else {
      sentiment = ruleBasedSentimentScore([...headlines, catalystRow.event_detail]);
      sentimentLabel =
        sentiment >= 65 ? "positive" : sentiment <= 35 ? "negative" : "neutral";
    }

    // Sector: real relative strength when the shortlist carries it
    // (ticker month % minus its sector ETF month %), otherwise the
    // old keyword bump, otherwise neutral 50.
    let sector = 50;
    const sectorRel = m?.sector_rel_pct;
    if (sectorRel !== null && sectorRel !== undefined) {
      sector = clamp(50 + Number(sectorRel) * 5);
    } else {
      const sectorName = (constituent?.sector ?? "").toLowerCase();
      if (sectorName) {
        const sectorKeywords: Record<string, string[]> = {
          energy: ["oil", "crude", "opec", "energy"],
          financial: ["fed", "fomc", "interest rate", "bank"],
          "information technology": ["semiconductor", "chip", "ai"],
        };
        for (const [sectorKey, words] of Object.entries(sectorKeywords)) {
          if (!sectorName.includes(sectorKey)) continue;
          if (headlines.some((h) => words.some((w) => h.toLowerCase().includes(w)))) {
            sector = 65;
          }
        }
      }
    }

    // Volume: real ratio from weekly candles when available, else
    // on-demand candle ratio, else neutral 50 (never invented).
    const volumeRatioRaw =
      m?.volume_ratio !== null && m?.volume_ratio !== undefined
        ? Number(m.volume_ratio)
        : mode === "on_demand"
          ? onDemandCandle?.volumeRatio
          : undefined;
    const volume =
      volumeRatioRaw === undefined
        ? 50
        : volumeRatioRaw >= 1.5
          ? 85
          : volumeRatioRaw >= 1.2
            ? 75
            : volumeRatioRaw >= 1.0
              ? 65
              : volumeRatioRaw >= 0.8
                ? 50
                : volumeRatioRaw >= 0.5
                  ? 35
                  : 20;

    const volNote = volScore !== null && m?.avg_abs_daily_pct !== null && m?.avg_abs_daily_pct !== undefined
      ? ` Volatility: avg daily move ${Number(m.avg_abs_daily_pct).toFixed(1)}%.`
      : "";
    const proxNote = daysToEvent !== null && daysToEvent >= 0 && daysToEvent <= 7
      ? ` Earnings in ${daysToEvent} day${daysToEvent === 1 ? "" : "s"}.`
      : "";
    candidates.push({
      ticker,
      technical,
      catalyst: catalystScore,
      sentiment,
      volume,
      sector,
      reasoning: `${catalystRow.reasoning}${volNote}${proxNote}`,
      catalystLabel: `${catalystRow.catalyst_type}: ${catalystRow.event_detail}`,
      sentimentLabel,
      price: quote.price,
      change1dPct,
      change5dPct:
        mode === "on_demand"
          ? onDemandCandle?.change5dPct
          : m?.change_5d_pct !== null && m?.change_5d_pct !== undefined
            ? Number(m.change_5d_pct)
            : undefined,
      volumeRatio: volumeRatioRaw,
      company,
      sources: `Quote: ${quote.source}; catalyst: weekly_shortlist`,
    });
  }

  const rows = candidates
    .map((c) => {
      const score = scoreCandidate(c);
      return {
        ticker: c.ticker,
        company: c.company ?? null,
        price: c.price ?? null,
        change_1d_pct: c.change1dPct ?? null,
        change_5d_pct: c.change5dPct ?? null,
        volume_ratio: c.volumeRatio ?? null,
        score,
        catalyst: c.catalystLabel ?? null,
        sentiment: c.sentimentLabel ?? null,
        reasoning: c.reasoning,
        sources: c.sources ?? null,
        confidence: confidenceFor(score),
      };
    })
    .sort((a, b) => b.score - a.score);

  const [scan] = await sql`
    INSERT INTO scans (market_status, universe, notes)
    VALUES (
      ${status},
      ${mode === "on_demand" ? `on_demand:${universe[0] ?? ""}` : "weekly_shortlist:50"},
      ${universe.length === 0 ? "No daily shortlist yet — run /api/weekly first." : null}
    )
    RETURNING id
  `;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await sql`
      INSERT INTO leaderboard
        (scan_id, scanned_at, rank, ticker, company, price,
         change_1d_pct, change_5d_pct, volume_ratio, score,
         catalyst, sentiment, reasoning, sources, confidence, target_pct)
      VALUES (
        ${scan.id}, ${now}, ${i + 1}, ${r.ticker}, ${r.company}, ${r.price},
        ${r.change_1d_pct}, ${r.change_5d_pct}, ${r.volume_ratio}, ${r.score},
        ${r.catalyst}, ${r.sentiment}, ${r.reasoning}, ${r.sources},
        ${r.confidence}, 5.0
      )
    `;
  }

  return NextResponse.json({
    ok: true,
    scanId: scan.id,
    scannedAt: now,
    marketStatus: status,
    mode,
    universeTickers: universe.length,
    universe,
    quotesFetched: quotes.size,
    quotesMissing: universe.length - quotes.size,
    llmSentimentUsed,
    rows: rows.length,
  });
}

// Allow cron-job.org jobs configured with GET as well.
export async function GET(req: NextRequest) {
  return POST(req);
}
