import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { placeNotionalBuy, TRADE_NOTIONAL_USD } from "@/lib/alpaca";

// Weekly paper buys: top 3 from the latest leaderboard scan, $100 each.
// Triggered by cron-job.org once a week, during market hours (e.g.
// Monday 09:45 ET, after the leaderboard has a fresh top 3).
// Same CRON_SECRET protection as /api/scan. Paper only — see lib/alpaca.ts.
//
// Behaviour on purpose:
// - Skips a ticker already open this week (no duplicate $100 buys).
// - Does NOT automatically close positions at week end. A position is
//   closed only by /api/trade/check at +5% / -3% (see that route).
//   If Durkan wants a week-end close as well, that is a separate rule
//   to add, not a silent default.
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
  const latest = await sql`
    SELECT id FROM scans ORDER BY id DESC LIMIT 1
  `;
  if (latest.length === 0) {
    return NextResponse.json({ ok: false, error: "no leaderboard scan yet" }, { status: 400 });
  }
  const top3 = await sql`
    SELECT rank, ticker FROM leaderboard
    WHERE scan_id = ${latest[0].id} ORDER BY rank ASC LIMIT 3
  `;

  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay();
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  const results = [];
  for (const row of top3) {
    const ticker = row.ticker as string;
    const existing = await sql`
      SELECT id FROM paper_trades
      WHERE ticker = ${ticker} AND week_start = ${weekStart} AND status = 'open'
      LIMIT 1
    `;
    if (existing.length > 0) {
      results.push({ ticker, skipped: "already open this week" });
      continue;
    }
    const order = await placeNotionalBuy(ticker, TRADE_NOTIONAL_USD);
    await sql`
      INSERT INTO paper_trades
        (week_start, ticker, leaderboard_rank, notional_usd, alpaca_order_id, status)
      VALUES (${weekStart}, ${ticker}, ${row.rank}, ${TRADE_NOTIONAL_USD}, ${order?.id ?? null}, 'open')
    `;
    results.push({ ticker, rank: row.rank, notional: TRADE_NOTIONAL_USD, orderId: order?.id ?? null });
  }

  return NextResponse.json({ ok: true, weekStart, results });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
