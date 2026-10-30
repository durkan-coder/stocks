// Staggered daily-technicals slice: ONE slice of the universe per
// run, monthly candles only (RSI, month %, volume ratio, avg daily
// move, change-5d). CRON_SECRET-protected, for a pre-market
// cron-job.org job (e.g. every 10 minutes overnight): each run makes
// at most 50 candle calls via getMonthlyCandleData (Finnhub, with a
// TwelveData fallback), so a full 500-ticker technical refresh takes
// ~100 minutes spread out, never a 100-call burst against the
// 60/min Finnhub limit. Results go to price_cache's companion table
// ticker_technicals, which /api/scan can read in future; today they
// are shown on the dashboard as staggered coverage. A failed slice
// still advances — it comes round again tomorrow.
import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getMonthlyCandleData, mapLimit } from "@/lib/feed";
import { getUniverse, sliceUniverse, sliceCount } from "@/lib/universe";

export const maxDuration = 60;

async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const sql = neon(process.env.DATABASE_URL!);
  await sql`CREATE TABLE IF NOT EXISTS ticker_technicals (ticker TEXT PRIMARY KEY, month_pct NUMERIC, rsi14 NUMERIC, volume_ratio NUMERIC, avg_abs_daily_pct NUMERIC, change_5d_pct NUMERIC, updated_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS stagger_state (job TEXT PRIMARY KEY, slice INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())`;

  const { list, source } = await getUniverse();
  const totalSlices = sliceCount(list.length, 50);
  const prev = await sql`SELECT slice FROM stagger_state WHERE job = 'daily'`;
  const slice = prev.length > 0 ? (Number((prev[0] as { slice: number }).slice) + 1) % totalSlices : 0;
  const sliceTickers = sliceUniverse(list, slice, 50);
  const now = new Date().toISOString();
  const pairs = await mapLimit(sliceTickers, 4, async (c) => ({
    ticker: c.ticker,
    data: await getMonthlyCandleData(c.ticker),
  }));
  let written = 0;
  for (const p of pairs) {
    if (!p.data) continue;
    written++;
    await sql`INSERT INTO ticker_technicals (ticker, month_pct, rsi14, volume_ratio, avg_abs_daily_pct, change_5d_pct, updated_at) VALUES (${p.ticker}, ${p.data.monthPct}, ${p.data.rsi14}, ${p.data.volumeRatio}, ${p.data.avgAbsDailyPct}, ${p.data.change5dPct}, ${now}) ON CONFLICT (ticker) DO UPDATE SET month_pct = EXCLUDED.month_pct, rsi14 = EXCLUDED.rsi14, volume_ratio = EXCLUDED.volume_ratio, avg_abs_daily_pct = EXCLUDED.avg_abs_daily_pct, change_5d_pct = EXCLUDED.change_5d_pct, updated_at = EXCLUDED.updated_at`;
  }
  await sql`INSERT INTO stagger_state (job, slice, updated_at) VALUES ('daily', ${slice}, ${now}) ON CONFLICT (job) DO UPDATE SET slice = EXCLUDED.slice, updated_at = EXCLUDED.updated_at`;
  const covered = await sql`SELECT COUNT(*) AS n FROM ticker_technicals WHERE updated_at > NOW() - INTERVAL '26 hours'`;
  return NextResponse.json({
    ok: true,
    universeSource: source,
    universeTickers: list.length,
    slice,
    totalSlices,
    sliceTickers: sliceTickers.length,
    technicalsWritten: written,
    technicalsMissing: sliceTickers.length - written,
    coveredLast26h: Number((covered[0] as { n: string }).n),
    nextSlice: (slice + 1) % totalSlices,
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}
export async function GET(req: NextRequest) {
  return run(req);
}
