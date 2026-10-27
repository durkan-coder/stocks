import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { placeNotionalBuy, TRADE_NOTIONAL_USD } from "@/lib/alpaca";

// Daily paper buy: ONE unique stock per day, from the latest
// leaderboard scan, in rank order.
// Triggered by cron-job.org once per trading day (e.g. 09:52 ET,
// after the 09:45 ET scan has landed, so it does not race the scan).
// Same CRON_SECRET protection as the other trade routes. Paper only.
//
// "Unique" means: a ticker is bought only if it has NEVER been bought
// before in paper_trades (any status, any week). Walk the leaderboard
// in rank order and buy the first ticker with no prior paper trade:
// if #1 was already bought, buy #2, then #3, and so on. If every
// leaderboard ticker has already been bought, buy nothing that day.
// This replaces the old weekly top-3 buy — do NOT run both jobs, or
// the same day could buy twice.
//
// Sell rule is unchanged and lives in /api/trade/check: a position is
// closed at +5% (take profit) or -3% (stop loss), based on Alpaca's
// unrealised P/L, with no waiting for an earnings trigger event.
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
  const rows = await sql`
    SELECT rank, ticker, price FROM leaderboard
    WHERE scan_id = ${latest[0].id} ORDER BY rank ASC
  `;

  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay();
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  for (const row of rows) {
    const ticker = row.ticker as string;
    const prior = await sql`
      SELECT id FROM paper_trades WHERE ticker = ${ticker} LIMIT 1
    `;
    if (prior.length > 0) continue; // already bought before — next in sequence
    let order: any;
    try {
      order = await placeNotionalBuy(ticker, TRADE_NOTIONAL_USD);
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: "alpaca_buy_failed", ticker, detail: String(e?.message ?? e).slice(0, 300) },
        { status: 502 },
      );
    }
    await sql`
      INSERT INTO paper_trades
        (week_start, ticker, leaderboard_rank, entry_price, notional_usd, alpaca_order_id, status)
      VALUES (${weekStart}, ${ticker}, ${row.rank}, ${row.price ?? null}, ${TRADE_NOTIONAL_USD}, ${order?.id ?? null}, 'open')
    `;
    return NextResponse.json({
      ok: true,
      weekStart,
      bought: { ticker, rank: row.rank, notional: TRADE_NOTIONAL_USD, orderId: order?.id ?? null },
    });
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    bought: null,
    note: "every leaderboard ticker has already been bought — nothing bought today",
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
