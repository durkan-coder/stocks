import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { closePosition, getPositions } from "@/lib/alpaca";
import { isPinValid } from "@/lib/approvalPin";
import { sweepTaxReserve } from "@/lib/taxPark";

// Manual sell: close one open paper position at the current market
// price, on the user's explicit action in the portfolio home.
// Paper only, $100 positions, PIN-gated like approve/reject.
//
// Auto sells are OFF by choice (2026-11-09, manual only):
// /api/trade/check no longer sells, it only watches the +3% / -2%
// thresholds and records alerts for notification. So this route is
// the ONLY way a position closes. The whole position is sold —
// there is no partial sell. Exit price and P/L come from the live
// Alpaca position read just before closing, and are recorded in
// paper_trades + trade_attempts like the automatic closes were.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let tradeId: number | null = null;
  let pin: string | null = null;
  try {
    const form = await req.formData();
    tradeId = Number(form.get("tradeId"));
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      tradeId = Number(body.tradeId);
      pin = body.pin ? String(body.pin) : null;
    } catch {
      tradeId = null;
    }
  }
  // Redirect home WITH a visible result notice, like approve/reject.
  const homeWith = (notice: string, ticker?: string) => {
    const u = new URL("/", req.url);
    u.searchParams.set("notice", notice);
    if (ticker) u.searchParams.set("ticker", ticker);
    return NextResponse.redirect(u);
  };
  // PIN gate, before any trade action: fail closed if APPROVAL_PIN
  // is unset or the PIN does not match. Never log the PIN value.
  if (!isPinValid(pin)) {
    return homeWith("pin_invalid");
  }
  if (!tradeId || !Number.isFinite(tradeId)) {
    return homeWith("sell_no_trade");
  }

  const rows = await sql`
    SELECT id, ticker, leaderboard_rank, entry_price, status
    FROM paper_trades WHERE id = ${tradeId} LIMIT 1
  `;
  if (rows.length === 0) return homeWith("sell_no_trade");
  const trade = rows[0];
  const ticker = trade.ticker as string;
  if (trade.status !== "open") return homeWith("sell_already_closed", ticker);

  let positions: any[];
  try {
    positions = await getPositions();
  } catch {
    return homeWith("sell_alpaca_failed", ticker);
  }
  const pos = positions.find((p: any) => p.symbol === ticker);
  if (!pos) return homeWith("sell_no_position", ticker);
  const exitPrice = Number(pos.current_price);
  const plpc = Number(pos.unrealized_plpc);

  try {
    await closePosition(ticker);
  } catch {
    return homeWith("sell_alpaca_failed", ticker);
  }

  // pnl_pct is stored as a FRACTION (e.g. 0.032), matching
  // /api/trade/check and the journal's display (pnl * 100 = %).
  await sql`
    UPDATE paper_trades
    SET status = 'closed_manual', exit_price = ${Number.isFinite(exitPrice) ? exitPrice : null},
        pnl_pct = ${Number.isFinite(plpc) ? plpc : null}, closed_at = NOW()
    WHERE id = ${trade.id}
  `;
  try {
    await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
      VALUES ('manual_sell', NULL, ${ticker}, ${trade.leaderboard_rank}, 'sold_manual', ${`manual sell at $${exitPrice}, plpc ${plpc}`})`;
  } catch { /* logging must not block */ }
  // Tax parking, same buy pattern as a stock buy: if this sale
  // created (or added to) tax owed, sweep the un-parked amount
  // into SGOV (money market ETF) as a real Alpaca paper buy. The
  // sweep never throws and never fails the sale: a failed park
  // just leaves the amount "awaiting parking" on the home card.
  try {
    await sweepTaxReserve(sql);
  } catch { /* park failure must not block the sell result */ }
  return homeWith("sold_manual", ticker);
}
