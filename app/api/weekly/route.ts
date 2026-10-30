import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { selectTop50, type CatalystEvent } from "@/lib/weekly";
import {
  addDays,
  buildCatalystEvents,
  feedDiagnostics,
  getCompanyNews,
  getEarningsCalendar,
  getEarningsHistory,
  getMacroEvents,
  getMonthlyCandleData,
  getSp500Constituents,
  type MonthlyCandleData,
  isoDate,
  mapLimit,
  type NewsItem,
} from "@/lib/feed";
import { analyzeSentimentBatch, screenSetups, sentimentToScore100 } from "@/lib/openrouter";

// Stage 1, run EVERY DAY via cron-job.org (e.g. pre-market ET).
// The 1-week horizon stays the same — the event must be within the
// coming 7 days — but the list is rebuilt daily so a stock that gains
// a new catalyst is added the same day, not next week, and flagged is_new.
// Same CRON_SECRET protection as /api/scan.
//
// Real feed (see lib/feed.ts): FMP S&P 500 constituents, Finnhub
// earnings calendar for the coming 7 days, and Finnhub company news
// for earnings tickers only (rate-limit guard). General market news
// is NOT used as a per-ticker catalyst — a broad headline mapped to
// a whole sector was copy-paste, not company evidence, so it was removed.
// LLM sentiment (lib/openrouter.ts) is called HERE, once a day, in
// batches of <=10 tickers — never in the 15-minute scan. Its result is
// stored in weekly_shortlist.reasoning so /api/scan can reuse it.
// Monthly candlestick summaries (lib/feed.ts getMonthlyCandleSummary)
// are also computed HERE, once a day, reasoning-only — no score change.
// If every feed call fails, this route writes nothing rather than a
// fake 50: an empty shortlist is correct, and /api/scan will then
// record an empty scan.
export const dynamic = "force-dynamic";
// Weekly rebuild does many provider calls (constituents, earnings,
// company news for up to 40 tickers, LLM sentiment batches), so give
// it the same headroom as /api/scan. Without this, Vercel's default
// function limit can cut the run short and cron-job.org reports a
// timeout even when some rows were already written.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const sql = neon(process.env.DATABASE_URL!);
  const now = new Date();
  const from = isoDate(now);
  const to = isoDate(addDays(now, 7));
  const newsFrom = isoDate(addDays(now, -3));

  const constituentsResult = await getSp500Constituents();
  const constituents = constituentsResult.list;
  const earnings = await getEarningsCalendar(from, to);

  // Company news only for earnings tickers (bounded, fail-soft).
  // Earnings tickers not in the constituent list are ignored later,
  // so only fetch news for the intersection, capped at 40.
  const constituentTickers = new Set(constituents.map((c) => c.ticker));
  const earningsTickers = [...new Set(earnings.map((e) => e.symbol))]
    .filter((t) => constituentTickers.has(t))
    .slice(0, 40);
  const companyNewsPairs = await mapLimit(earningsTickers, 5, async (t) => ({
    ticker: t,
    news: await getCompanyNews(t, newsFrom, from),
  }));
  const companyNewsByTicker = new Map<string, NewsItem[]>();
  for (const pair of companyNewsPairs) {
    if (pair.news.length > 0) companyNewsByTicker.set(pair.ticker, pair.news);
  }

  const events: CatalystEvent[] = buildCatalystEvents({
    constituents,
    earnings,
    companyNewsByTicker,
  });
  const top50 = selectTop50(events);

  // LLM sentiment, once a day, batched (<=10 per call). Headlines are
  // the company's own news where available, else the event detail.
  // On failure / no key, analyzeSentimentBatch returns an empty map
  // and the reasoning below simply has no LLM suffix — never a fake.
  const sentimentByTicker = new Map<string, { score100: number; label: string; reason: string }>();
  if (top50.length > 0) {
    for (let i = 0; i < top50.length; i += 10) {
      const batch = top50.slice(i, i + 10).map((e) => ({
        ticker: e.ticker,
        headlines: (companyNewsByTicker.get(e.ticker) ?? [])
          .slice(0, 3)
          .map((n) => n.headline),
      }));
      const results = await analyzeSentimentBatch(batch);
      for (const r of results.values()) {
        sentimentByTicker.set(r.ticker, {
          score100: sentimentToScore100(r.score),
          label: r.label,
          reason: r.reason,
        });
      }
    }
  }

  // Week starting Monday (UTC date) — kept for grouping; the rebuild
  // itself is daily, keyed by created_at in the queries.
  const monday = new Date(now);
  const day = now.getUTCDay(); // 0 = Sunday
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  // New-ticker detection: tickers in today's top 50 that were NOT in
  // any earlier shortlist. These are what the user wants to spot.
  let previous = new Set<string>();
  try {
    const prevRows = await sql`
      SELECT DISTINCT ticker FROM weekly_shortlist
      WHERE DATE(created_at) < CURRENT_DATE
    `;
    previous = new Set(prevRows.map((r: any) => r.ticker as string));
  } catch {
    previous = new Set();
  }
  const newTickers = top50.filter((e) => !previous.has(e.ticker)).map((e) => e.ticker);

  // Monthly candlestick summary, once a day, reasoning-only.
  // Daily candles for the shortlist tickers only (never per 15-min
  // scan tick), concurrency 4 (lowered from 8: the weekly run makes
  // ~100+ Finnhub calls against a 60/min free limit, and the
  // monthly batch was the one returning empty on Oct 28), fail-soft
  // per ticker, with a TwelveData fallback inside
  // getMonthlyCandleData. A ticker with no data from either provider
  // simply gets no monthly line. This does NOT change any score —
  // technical/volume/catalyst/sentiment are computed exactly as
  // before in /api/scan.
  const monthlyByTicker = new Map<string, MonthlyCandleData>();
  if (top50.length > 0) {
    const monthlyPairs = await mapLimit(top50, 4, async (e) => ({
      ticker: e.ticker,
      data: await getMonthlyCandleData(e.ticker),
    }));
    for (const pair of monthlyPairs) {
      if (pair.data) monthlyByTicker.set(pair.ticker, pair.data);
    }
  }

  // Sector relative strength: month % of the 11 sector ETFs, fetched
  // once a day (11 candle calls). A ticker's sector-relative move is
  // its month % minus its sector ETF's month % — a real sector score
  // input for /api/scan, replacing the old keyword bump.
  const sectorEtfBySector: Record<string, string> = {
    "Information Technology": "XLK", Technology: "XLK",
    Financials: "XLF", "Financial Services": "XLF",
    "Communication Services": "XLC",
    "Health Care": "XLV", Healthcare: "XLV",
    "Consumer Discretionary": "XLY",
    Industrials: "XLI",
    "Consumer Staples": "XLP",
    Energy: "XLE",
    Utilities: "XLU",
    "Real Estate": "XLRE",
    Materials: "XLB",
  };
  const sectorMonthByEtf = new Map<string, number>();
  try {
    // Dedupe: XLK/XLF/XLV each appear twice in the sector map, so
    // the old Object.values list made 14 ETF calls for 11 ETFs.
    const etfPairs = await mapLimit([...new Set(Object.values(sectorEtfBySector))], 4, async (etf) => ({
      etf,
      data: await getMonthlyCandleData(etf),
    }));
    for (const pair of etfPairs) {
      if (pair.data) sectorMonthByEtf.set(pair.etf, pair.data.monthPct);
    }
  } catch {
    // ETF failure -> sector-relative is null, scan falls back to 50.
  }
  const constituentSectorByTicker = new Map(constituents.map((c) => [c.ticker, c.sector ?? ""]));
  const sectorRelByTicker = new Map<string, number>();
  for (const e of top50) {
    const m = monthlyByTicker.get(e.ticker);
    const sector = constituentSectorByTicker.get(e.ticker) ?? "";
    const etf = sectorEtfBySector[sector];
    const etfMonth = etf ? sectorMonthByEtf.get(etf) : undefined;
    if (m && etfMonth !== undefined) sectorRelByTicker.set(e.ticker, m.monthPct - etfMonth);
  }

  // Earnings surprise history for earnings tickers in the shortlist.
  // Small score modifier only: beat >=3/4 -> +3, beat <=1/4 -> -3,
  // otherwise 0. Reasoning always carries the history line.
  const earningsHistoryByTicker = new Map<string, { beats: number; total: number; avgSurprisePct: number | null; summary: string }>();
  try {
    const earningsTop = top50.filter((e) => e.type === "earnings");
    const histPairs = await mapLimit(earningsTop, 5, async (e) => ({
      ticker: e.ticker,
      hist: await getEarningsHistory(e.ticker),
    }));
    for (const pair of histPairs) {
      if (pair.hist) earningsHistoryByTicker.set(pair.ticker, pair.hist);
    }
  } catch {
    // History failure -> no modifier, no history line.
  }
  for (const e of top50) {
    const h = earningsHistoryByTicker.get(e.ticker);
    if (!h || h.total < 3) continue;
    if (h.beats >= 3) e.score = Math.min(100, e.score + 3);
    else if (h.beats <= 1) e.score = Math.max(0, e.score - 3);
  }
  top50.sort((a, b) => b.score - a.score);

  // Macro events this week (dashboard note only, not a per-ticker catalyst).
  let macroEvents: Array<{ date: string; event: string }> = [];
  try {
    macroEvents = await getMacroEvents(from, to);
  } catch {
    macroEvents = [];
  }

  // LLM screen (our LLM, OpenRouter free model — not Gemini): one call
  // over the top 15 shortlist candidates, grounded in verified data
  // only (catalyst, RSI, month trend, volume, historical volatility,
  // headlines, stored sentiment). Returns up to 5 picks with reasons,
  // or [] on any failure. Research ranking only: it does NOT change
  // leaderboard scores, shortlist scores, or paper trades.
  let llmScreen: Array<{ ticker: string; reason: string }> = [];
  try {
    const candidates = top50.slice(0, 15).map((e) => {
      const m = monthlyByTicker.get(e.ticker);
      const s = sentimentByTicker.get(e.ticker);
      return {
        ticker: e.ticker,
        catalystType: e.type,
        eventDate: e.eventDate,
        eventDetail: e.detail,
        shortlistScore: e.score,
        rsi14: m?.rsi14 ?? null,
        monthPct: m?.monthPct ?? null,
        volumeRatio: m?.volumeRatio ?? null,
        avgAbsDailyPct: m?.avgAbsDailyPct ?? null,
        breakout: m?.breakout ?? false,
        sentimentLabel: s?.label ?? "neutral",
        headlines: (companyNewsByTicker.get(e.ticker) ?? []).slice(0, 2).map((n) => n.headline),
      };
    });
    llmScreen = await screenSetups(candidates);
  } catch {
    llmScreen = [];
  }

  // Numeric candle/earnings/sector columns for /api/scan scoring.
  // Created here if missing, so no manual Neon SQL is needed.
  try {
    await sql`ALTER TABLE weekly_shortlist
      ADD COLUMN IF NOT EXISTS rsi14 NUMERIC,
      ADD COLUMN IF NOT EXISTS month_pct NUMERIC,
      ADD COLUMN IF NOT EXISTS volume_ratio NUMERIC,
      ADD COLUMN IF NOT EXISTS avg_abs_daily_pct NUMERIC,
      ADD COLUMN IF NOT EXISTS change_5d_pct NUMERIC,
      ADD COLUMN IF NOT EXISTS sector_rel_pct NUMERIC,
      ADD COLUMN IF NOT EXISTS expected_move_pct NUMERIC,
      ADD COLUMN IF NOT EXISTS expected_move_expiry DATE,
      ADD COLUMN IF NOT EXISTS expected_move_iv NUMERIC,
      ADD COLUMN IF NOT EXISTS earnings_beats INTEGER,
      ADD COLUMN IF NOT EXISTS earnings_total INTEGER,
      ADD COLUMN IF NOT EXISTS avg_surprise_pct NUMERIC`;
  } catch {
    // If ALTER fails, inserts below still run without the new columns
    // only if the columns already exist; otherwise this run's inserts
    // will fail and the next run (after init-db) will succeed.
  }

  for (const e of top50) {
    const llm = sentimentByTicker.get(e.ticker);
    const m = monthlyByTicker.get(e.ticker);
    const hist = earningsHistoryByTicker.get(e.ticker);
    const sectorRel = sectorRelByTicker.get(e.ticker);
    // event_detail stays the raw catalyst; reasoning carries it plus
    // the monthly candle summary, earnings history, sector-relative
    // move, and the stored LLM sentiment, which /api/scan parses
    // back out (LLM regex) and displays as-is.
    const reasoning = [
      e.detail,
      m?.summary ?? null,
      hist?.summary ?? null,
      sectorRel !== undefined ? `vs sector: ${sectorRel >= 0 ? "+" : ""}${sectorRel.toFixed(1)}% this month.` : null,
      llm
        ? `Sentiment (LLM): ${llm.label}, ${((llm.score100 - 50) / 50).toFixed(2)} — ${llm.reason}`
        : null,
    ]
      .filter((p): p is string => p !== null)
      .join(" ");
    await sql`
      INSERT INTO weekly_shortlist
        (week_start, ticker, company, catalyst_type, event_date,
         event_detail, reasoning, score, sources, is_new,
         rsi14, month_pct, volume_ratio, avg_abs_daily_pct, change_5d_pct,
         sector_rel_pct, expected_move_pct, expected_move_expiry, expected_move_iv,
         earnings_beats, earnings_total, avg_surprise_pct)
      VALUES (
        ${weekStart}, ${e.ticker}, ${e.company ?? null}, ${e.type},
        ${e.eventDate ?? null}, ${e.detail}, ${reasoning}, ${e.score},
        ${e.sources ?? null}, ${!previous.has(e.ticker)},
        ${m?.rsi14 ?? null}, ${m?.monthPct ?? null}, ${m?.volumeRatio ?? null},
        ${m?.avgAbsDailyPct ?? null}, ${m?.change5dPct ?? null},
        ${sectorRel ?? null}, ${null}, ${null},
        ${null}, ${hist?.beats ?? null}, ${hist?.total ?? null},
        ${hist?.avgSurprisePct ?? null}
      )
    `;
  }

  // Macro events for the dashboard (replacing today's rows).
  try {
    await sql`CREATE TABLE IF NOT EXISTS macro_events (
      id SERIAL PRIMARY KEY,
      event_date DATE NOT NULL,
      event TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`DELETE FROM macro_events WHERE DATE(created_at) = CURRENT_DATE`;
    for (const ev of macroEvents) {
      await sql`INSERT INTO macro_events (event_date, event) VALUES (${ev.date}, ${ev.event})`;
    }
  } catch {
    // Macro storage failure must not fail the weekly rebuild.
  }

  // Store today's LLM screen, replacing any earlier screen from the
  // same calendar day (weekly rebuilds are daily, one screen per day).
  // Table is created here if missing, so no manual Neon SQL is needed;
  // /api/init-db creates the same table for completeness.
  try {
    await sql`CREATE TABLE IF NOT EXISTS llm_screen (
      id SERIAL PRIMARY KEY,
      screen_date DATE NOT NULL,
      rank INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      reason TEXT NOT NULL,
      catalyst_type TEXT,
      event_date DATE,
      rsi14 NUMERIC,
      month_pct NUMERIC,
      volume_ratio NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`DELETE FROM llm_screen WHERE DATE(created_at) = CURRENT_DATE`;
    for (let i = 0; i < llmScreen.length; i++) {
      const pick = llmScreen[i];
      const e = top50.find((x) => x.ticker === pick.ticker);
      const m = monthlyByTicker.get(pick.ticker);
      await sql`
        INSERT INTO llm_screen
          (screen_date, rank, ticker, reason, catalyst_type, event_date, rsi14, month_pct, volume_ratio)
        VALUES (
          ${now.toISOString().slice(0, 10)}, ${i + 1}, ${pick.ticker}, ${pick.reason},
          ${e?.type ?? null}, ${e?.eventDate ?? null},
          ${m?.rsi14 ?? null}, ${m?.monthPct ?? null}, ${m?.volumeRatio ?? null}
        )
      `;
    }
  } catch {
    // Screen storage failure must not fail the whole weekly rebuild;
    // the shortlist above is already written. An empty screen is shown.
    llmScreen = [];
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    runDate: now.toISOString().slice(0, 10),
    tickers: top50.length,
    newTickers,
    constituentsSource: constituentsResult.source,
    constituents: constituents.length,
    earningsInWindow: earnings.length,
    companyNewsTickers: companyNewsByTicker.size,
    sentimentTickers: sentimentByTicker.size,
    monthlyCandleTickers: monthlyByTicker.size,
    earningsHistoryTickers: earningsHistoryByTicker.size,
    sectorEtfTickers: sectorMonthByEtf.size,
    macroEvents: macroEvents.length,
    llmScreenTickers: llmScreen.length,
    llmScreen,
    // Diagnostics only: HTTP status per provider (no keys, no bodies).
    // 401 = bad key, 402 = paid endpoint, 403 = plan blocked,
    // 429 = rate limit, timeout-or-network-error = fetch failed.
    feedDiagnostics,
    note:
      top50.length === 0
        ? "No verified catalysts in the coming 7 days — no rows written, by design."
        : undefined,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
