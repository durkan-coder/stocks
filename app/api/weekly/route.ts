import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { selectTop50, type CatalystEvent } from "@/lib/weekly";
import {
  addDays,
  buildCatalystEvents,
  feedDiagnostics,
  getCompanyNews,
  getEarningsCalendar,
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
  // scan tick), concurrency 8, fail-soft per ticker: a ticker with
  // no candle data simply gets no monthly line. This does NOT
  // change any score — technical/volume/catalyst/sentiment are
  // computed exactly as before in /api/scan.
  const monthlyByTicker = new Map<string, MonthlyCandleData>();
  if (top50.length > 0) {
    const monthlyPairs = await mapLimit(top50, 8, async (e) => ({
      ticker: e.ticker,
      data: await getMonthlyCandleData(e.ticker),
    }));
    for (const pair of monthlyPairs) {
      if (pair.data) monthlyByTicker.set(pair.ticker, pair.data);
    }
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

  for (const e of top50) {
    const llm = sentimentByTicker.get(e.ticker);
    const monthly = monthlyByTicker.get(e.ticker)?.summary;
    // event_detail stays the raw catalyst; reasoning carries it plus
    // the monthly candle summary and the stored LLM sentiment, which
    // /api/scan parses back out (LLM regex) and displays as-is.
    const reasoning = [
      e.detail,
      monthly ?? null,
      llm
        ? `Sentiment (LLM): ${llm.label}, ${((llm.score100 - 50) / 50).toFixed(2)} — ${llm.reason}`
        : null,
    ]
      .filter((p): p is string => p !== null)
      .join(" ");
    await sql`
      INSERT INTO weekly_shortlist
        (week_start, ticker, company, catalyst_type, event_date,
         event_detail, reasoning, score, sources, is_new)
      VALUES (
        ${weekStart}, ${e.ticker}, ${e.company ?? null}, ${e.type},
        ${e.eventDate ?? null}, ${e.detail}, ${reasoning}, ${e.score},
        ${e.sources ?? null}, ${!previous.has(e.ticker)}
      )
    `;
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
