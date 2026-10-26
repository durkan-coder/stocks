import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { closePosition, getPositions, shouldSell } from "@/lib/alpaca";

// TP/SL check: run every 15 minutes alongside /api/scan (cron-job.org).
// For each open paper trade, look up its Alpaca position's unrealised
// P/L percent. Sell the whole position if it is >= +5% (take profit)
// or <= -3% (stop loss). Nothing else closes a position here.
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
  const positions = await getPositions();
  const bySymbol = new Map(positions.map((p: any) => [p.symbol, p]));

  const open = await sql`
    SELECT id, ticker FROM paper_trades WHERE status = 'open' ORDER BY opened_at ASC
  `;

  const closed = [];
  const stillOpen = [];
  for (const trade of open) {
    const ticker = trade.ticker as string;
    const pos = bySymbol.get(ticker);
    if (!pos) {
      stillOpen.push({ ticker, note: "no live Alpaca position found — left open in DB" });
      continue;
    }
    const plpc = Number(pos.unrealized_plpc);
    const action = shouldSell(plpc);
    if (!action) {
      stillOpen.push({ ticker, plpc });
      continue;
    }
    await closePosition(ticker);
    const status = action === "take_profit" ? "closed_take_profit" : "closed_stop_loss";
    await sql`
      UPDATE paper_trades
      SET status = ${status}, exit_price = ${Number(pos.current_price)},
          pnl_pct = ${plpc}, closed_at = NOW()
      WHERE id = ${trade.id}
    `;
    closed.push({ ticker, action, plpc, exitPrice: Number(pos.current_price) });
  }

  return NextResponse.json({ ok: true, closed, stillOpen });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
