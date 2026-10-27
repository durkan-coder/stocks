import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { selectTop50, type CatalystEvent } from "@/lib/weekly";
import {
  addDays,
  buildCatalystEvents,
  feedDiagnostics,
  getCompanyNews,
  getEarningsCalendar,
  getSp500Constituents,
  isoDate,
  mapLimit,
  type NewsItem,
} from "@/lib/feed";
import { analyzeSentimentBatch, sentimentToScore100 } from "@/lib/openrouter";

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
// If every feed call fails, this route writes nothing rather than a
// fake 50: an empty shortlist is correct, and /api/scan will then
// record an empty scan.
export const dynamic = "force-dynamic";

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

  for (const e of top50) {
    const llm = sentimentByTicker.get(e.ticker);
    // event_detail stays the raw catalyst; reasoning carries it plus
    // the stored LLM sentiment, which /api/scan parses back out.
    const reasoning = llm
      ? `${e.detail} Sentiment (LLM): ${llm.label}, ${((llm.score100 - 50) / 50).toFixed(2)} — ${llm.reason}`
      : e.detail;
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
