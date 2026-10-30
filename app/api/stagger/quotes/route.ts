// Staggered quote slice: ONE slice of the SPY universe per run.
// CRON_SECRET-protected. Designed to be called by cron-job.org every
// 5 minutes: each run fetches at most 50 Finnhub quotes (well under
// the 60/min free limit and the 60s Vercel cap), writes them to
// price_cache, and advances the slice pointer in Neon. 10 slices x
// 5 minutes = the full universe refreshes every ~50 minutes, while
// the 15-minute shortlist scan (the board) is untouched.
// On any provider failure the run still advances the pointer —
// retrying the same slice immediately is what burns quota; the
// slice comes round again in ~50 minutes.
import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { getQuotes } from "@/lib/feed";
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
  await sql`CREATE TABLE IF NOT EXISTS price_cache (ticker TEXT PRIMARY KEY, price NUMERIC, change_pct NUMERIC, source TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS stagger_state (job TEXT PRIMARY KEY, slice INT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT NOW())`;

  const { list, source } = await getUniverse();
  const totalSlices = sliceCount(list.length, 50);
  const prev = await sql`SELECT slice FROM stagger_state WHERE job = 'quotes'`;
  const slice = prev.length > 0 ? (Number((prev[0] as { slice: number }).slice) + 1) % totalSlices : 0;
  const sliceTickers = sliceUniverse(list, slice, 50);
  const quotes = await getQuotes(sliceTickers.map((c) => c.ticker));
  const now = new Date().toISOString();
  for (const [ticker, q] of quotes) {
    await sql`INSERT INTO price_cache (ticker, price, change_pct, source, updated_at) VALUES (${ticker}, ${q.price}, ${q.changePct ?? null}, ${q.source}, ${now}) ON CONFLICT (ticker) DO UPDATE SET price = EXCLUDED.price, change_pct = EXCLUDED.change_pct, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at`;
  }
  await sql`INSERT INTO stagger_state (job, slice, updated_at) VALUES ('quotes', ${slice}, ${now}) ON CONFLICT (job) DO UPDATE SET slice = EXCLUDED.slice, updated_at = EXCLUDED.updated_at`;
  const covered = await sql`SELECT COUNT(*) AS n FROM price_cache WHERE updated_at > NOW() - INTERVAL '65 minutes'`;
  return NextResponse.json({
    ok: true,
    universeSource: source,
    universeTickers: list.length,
    slice,
    totalSlices,
    sliceTickers: sliceTickers.length,
    quotesFetched: quotes.size,
    quotesMissing: sliceTickers.length - quotes.size,
    coveredLast65Min: Number((covered[0] as { n: string }).n),
    nextSlice: (slice + 1) % totalSlices,
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}
export async function GET(req: NextRequest) {
  return run(req);
}
