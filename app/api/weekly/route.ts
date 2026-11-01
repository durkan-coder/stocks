import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { selectTop50, type CatalystEvent } from "@/lib/weekly";
import {
  addDays,
  buildCatalystEvents,
  feedDiagnostics,
  getCompanyNews,
  getEarningsCalendar,
  isoDate,
  mapLimit,
  type NewsItem,
} from "@/lib/feed";
import { getUniverse } from "@/lib/universe";

// STAGGERED WEEKLY — STAGE 1 (start), run EVERY DAY via cron-job.org
// (e.g. 06:30 pre-market). This route is deliberately FAST so it
// finishes well inside cron-job.org's 30-second client timeout:
// universe + earnings calendar (+ minimum-fill windows) + company
// news for earnings tickers only, then it WRITES the shortlist
// immediately with basic reasoning. No sentiment, no monthly
// candles, no earnings history, no LLM screen here — those run
// later, one 10-ticker slice at a time, in /api/weekly/step, which
// updates these rows in place. If every step after start fails,
// the board still exists for the 15-minute scan and the daily buy,
// just with thinner reasoning. If start itself is re-run the same
// day, today's rows + progress are replaced, never duplicated.
//
// Same CRON_SECRET protection as /api/scan. Catalyst rules are
// unchanged: earnings + the company's own news only, no invented
// rows, top-50 cap, minimum 10 via 7-day window extension to 28 days.
export const dynamic = "force-dynamic";
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

  const constituentsResult = await getUniverse();
  const constituents = constituentsResult.list;
  const earnings = await getEarningsCalendar(from, to);

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
  let top50 = selectTop50(events);

  // Minimum-fill: if top50 < 10, extend the earnings window in
  // 7-day steps (up to 28 days total) until 10 verified earnings
  // events are present. No ticker is ever invented to fill a slot.
  let fillWindowStart = to;
  let fillWindowEnd = to;
  while (top50.length < 10 && fillWindowEnd < isoDate(addDays(now, 28))) {
    fillWindowStart = isoDate(addDays(new Date(fillWindowEnd + "T00:00:00Z"), 1));
    fillWindowEnd = isoDate(addDays(new Date(fillWindowStart + "T00:00:00Z"), 6));
    const extraEarnings = await getEarningsCalendar(fillWindowStart, fillWindowEnd);
    if (extraEarnings.length === 0) continue;
    const extraEvents = buildCatalystEvents({
      constituents,
      earnings: extraEarnings,
      companyNewsByTicker: new Map(),
    });
    if (extraEvents.length === 0) continue;
    events.push(...extraEvents);
    top50 = selectTop50(events);
  }

  const monday = new Date(now);
  const day = now.getUTCDay(); // 0 = Sunday
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

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

  // Numeric/enrichment columns for /api/scan scoring. Created here
  // if missing, so no manual Neon SQL is needed. base_score is the
  // catalyst score at start time; the enrich step recomputes
  // score = base_score + earnings-history modifier, so a retried
  // enrich slice can never apply the modifier twice.
  try {
    await sql`ALTER TABLE weekly_shortlist
      ADD COLUMN IF NOT EXISTS base_score NUMERIC,
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
    // Inserts below still run if the columns already exist.
  }

  // Idempotent for the day: a re-run replaces today's rows and
  // resets progress, instead of duplicating the shortlist.
  try {
    await sql`DELETE FROM weekly_shortlist WHERE DATE(created_at) = CURRENT_DATE`;
  } catch {
    // First-ever run: table may not exist yet; inserts below fail
    // loudly in that case, which is correct — it must not silently
    // report success with no board.
  }

  for (const e of top50) {
    await sql`
      INSERT INTO weekly_shortlist
        (week_start, ticker, company, catalyst_type, event_date,
         event_detail, reasoning, score, base_score, sources, is_new,
         rsi14, month_pct, volume_ratio, avg_abs_daily_pct, change_5d_pct,
         sector_rel_pct, expected_move_pct, expected_move_expiry, expected_move_iv,
         earnings_beats, earnings_total, avg_surprise_pct)
      VALUES (
        ${weekStart}, ${e.ticker}, ${e.company ?? null}, ${e.type},
        ${e.eventDate ?? null}, ${e.detail}, ${e.detail}, ${e.score}, ${e.score},
        ${e.sources ?? null}, ${!previous.has(e.ticker)},
        ${null}, ${null}, ${null},
        ${null}, ${null},
        ${null}, ${null}, ${null},
        ${null}, ${null}, ${null},
        ${null}
      )
    `;
  }

  // Progress for /api/weekly/step. Stages, in order: enrich slices
  // (10 tickers each), sentiment slices, then finalize (macro +
  // LLM screen). A step that crashes leaves the pointer untouched,
  // so the next step call retries the same slice.
  try {
    await sql`CREATE TABLE IF NOT EXISTS weekly_progress (
      run_date DATE PRIMARY KEY,
      stage TEXT NOT NULL,
      slice INTEGER NOT NULL,
      finished BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`DELETE FROM weekly_progress WHERE run_date = CURRENT_DATE`;
    if (top50.length > 0) {
      await sql`INSERT INTO weekly_progress (run_date, stage, slice, finished)
        VALUES (CURRENT_DATE, 'enrich', 0, FALSE)`;
    }
  } catch {
    // Progress failure must not hide a successful shortlist write,
    // but the step route will then report idle — surfaced in the
    // response below via progressOk.
  }
  let progressOk = false;
  try {
    const rows = await sql`SELECT 1 FROM weekly_progress WHERE run_date = CURRENT_DATE LIMIT 1`;
    progressOk = rows.length > 0;
  } catch {
    progressOk = false;
  }

  return NextResponse.json({
    ok: true,
    stage: "started",
    weekStart,
    runDate: now.toISOString().slice(0, 10),
    tickers: top50.length,
    newTickers,
    constituentsSource: constituentsResult.source,
    constituents: constituents.length,
    earningsInWindow: earnings.length,
    companyNewsTickers: companyNewsByTicker.size,
    progressOk,
    nextStep: "/api/weekly/step",
    feedDiagnostics,
    note:
      top50.length === 0
        ? "No verified catalysts in the coming 7 days — no rows written, by design."
        : "Shortlist written. Enrichment runs in /api/weekly/step slices.",
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
