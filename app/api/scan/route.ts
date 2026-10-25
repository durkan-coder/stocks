import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { confidenceFor, marketStatus, scoreCandidate } from "@/lib/scan";

// Triggered externally by cron-job.org every 15 minutes, 24/7.
// Vercel free tier does not allow 15-minute Vercel Cron, so the trigger
// lives outside Vercel. This route must stay fast (Hobby function limits).
//
// Two-stage design (free-tier workaround):
// - Stage 1 (/api/weekly, once a week) picks ~50 tickers with a real
//   catalyst this week: earnings/results, macro, geopolitical, sector.
// - Stage 2 (this route) scans ONLY those 50 every 15 minutes.
// - Anything outside the 50 is checked on demand, e.g. /api/scan?ticker=XYZ,
//   not on every 15-minute run. Do NOT run an LLM over all 500 tickers.
//
// Security: cron-job.org must send Authorization: Bearer <CRON_SECRET>.
// Without it, anyone who finds the URL could spam your Neon database.
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
  const status = marketStatus();
  const now = new Date().toISOString();

  // Universe for THIS run — never all 500 on a 15-minute tick:
  // - ?ticker=XYZ  -> on-demand single ticker, outside the shortlist
  // - otherwise    -> latest weekly_shortlist, capped at 50
  const onDemand = req.nextUrl.searchParams.get("ticker")?.toUpperCase() ?? null;
  let universe: string[] = [];
  let mode = "shortlist";
  if (onDemand) {
    universe = [onDemand];
    mode = "on_demand";
  } else {
    try {
      const shortlist = await sql`
        SELECT ticker FROM weekly_shortlist
        WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
        ORDER BY score DESC LIMIT 50
      `;
      universe = shortlist.map((r: any) => r.ticker as string);
    } catch {
      // weekly_shortlist not created / no daily run yet: scan nothing
      // rather than falling back to all 500 and timing out.
      universe = [];
    }
  }

  // TODO: replace this placeholder with your real data layer, using
  // `universe` above as the ONLY tickers to fetch:
  // 1. Fetch quotes for `universe` (intraday when open, last close when closed).
  // 2. Fetch news / earnings / analyst catalysts for the last 24-72h.
  // 3. Score each ticker with scoreCandidate(), keep only candidates
  //    that have a named catalyst AND reasoning.
  // Until that layer is wired in, this route writes NO fake rows — a
  // scan with no verified candidates is recorded as an empty scan, so
  // the frontend never shows invented picks.
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
    rows: rows.length,
  });
}

// Allow cron-job.org jobs configured with GET as well.
export async function GET(req: NextRequest) {
  return POST(req);
}
