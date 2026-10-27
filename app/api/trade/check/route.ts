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

  // Check the DB first: with no open trades there is nothing to check,
  // so do NOT call Alpaca at all. Previously this route called Alpaca
  // unconditionally, so a bad Alpaca key / Alpaca outage made even an
  // empty check return 500 instead of a clean "nothing to do".
  const open = await sql`
    SELECT id, ticker FROM paper_trades WHERE status = 'open' ORDER BY opened_at ASC
  `;
  if (open.length === 0) {
    return NextResponse.json({ ok: true, closed: [], stillOpen: [], note: "no open paper trades — Alpaca not called" });
  }

  let positions: any[];
  try {
    positions = await getPositions();
  } catch (e: any) {
    // Return a JSON error with the Alpaca HTTP status (no key, no body
    // beyond a truncated message) instead of a bare Next.js 500, so a
    // cron test run shows WHY it failed.
    const msg = String(e?.message ?? e);
    const statusMatch = msg.match(/\((\d{3})\)/);
    return NextResponse.json(
      { ok: false, error: "alpaca_positions_failed", alpacaStatus: statusMatch ? Number(statusMatch[1]) : null, detail: msg.slice(0, 300) },
      { status: 502 },
    );
  }
  const bySymbol = new Map(positions.map((p: any) => [p.symbol, p]));

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
    try {
      await closePosition(ticker);
    } catch (e: any) {
      stillOpen.push({ ticker, plpc, note: `close failed: ${String(e?.message ?? e).slice(0, 200)}` });
      continue;
    }
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
