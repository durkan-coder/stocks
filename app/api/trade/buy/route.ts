import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { getLatestTradePrice, placeNotionalBuy, TRADE_NOTIONAL_USD } from "@/lib/alpaca";
import { isPinValid } from "@/lib/approvalPin";

// Ad-hoc buy (added 2026-11-12, Durkan: "a way to buy a stock on
// adhoc basis"): buy $100 of any ticker the user types, on demand,
// from the portfolio home — outside the daily leaderboard flow.
//
// Safety, in order:
//  1. PIN gate (fail closed if APPROVAL_PIN is unset or wrong).
//  2. Ticker must be a plausible symbol (letters/digits, one dot).
//  3. Refuse if the ticker already has an OPEN paper_trades row —
//     two open rows for one ticker would break the Sell button,
//     which closes the whole Alpaca position at once.
//  4. No score/fall guards and no daily cap: this is the user's
//     explicit call, not the scanner's pick. Previously bought and
//     closed tickers CAN be re-bought here.
//  5. $100 notional market order at the current price, same as an
//     approval. Entry price is the latest trade quote (falling
//     back to the board price); P/L is recomputed from Alpaca.
// Paper only, same as every other buy.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let tickerRaw: string | null = null;
  let pin: string | null = null;
  try {
    const form = await req.formData();
    tickerRaw = form.get("ticker") ? String(form.get("ticker")) : null;
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      tickerRaw = body.ticker ? String(body.ticker) : null;
      pin = body.pin ? String(body.pin) : null;
    } catch {
      tickerRaw = null;
    }
  }
  // Redirect home WITH a visible result notice (same pattern as
  // approve/reject/sell): a failed PIN, a duplicate, or a rejected
  // order must not look identical to a successful buy.
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
  const ticker = (tickerRaw ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,5}(\.[A-Z0-9]{1,2})?$/.test(ticker)) {
    return homeWith("buy_invalid");
  }

  const open = await sql`SELECT id FROM paper_trades WHERE ticker = ${ticker} AND status = 'open' LIMIT 1`;
  if (open.length > 0) {
    return homeWith("already_open", ticker);
  }

  let order: any;
  try {
    order = await placeNotionalBuy(ticker, TRADE_NOTIONAL_USD);
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 300);
    try {
      await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
        VALUES ('adhoc_buy', NULL, ${ticker}, NULL, 'alpaca_buy_failed', ${detail})`;
    } catch { /* logging must not block */ }
    return homeWith("adhoc_failed", ticker);
  }

  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay();
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  // Entry price: latest trade quote first (closest to the fill),
  // then the latest board price if the ticker is on it. The
  // positions screen recomputes P/L from Alpaca anyway; the entry
  // price is what the +3% / −2% levels are computed from.
  let entryPrice: number | null = null;
  try {
    entryPrice = await getLatestTradePrice(ticker);
  } catch { /* fall through to the board price */ }
  if (entryPrice === null) {
    try {
      const latest = await sql`SELECT id FROM scans ORDER BY id DESC LIMIT 1`;
      if (latest.length > 0) {
        const board = await sql`SELECT price FROM leaderboard WHERE scan_id = ${latest[0].id} AND ticker = ${ticker} LIMIT 1`;
        if (board.length > 0) entryPrice = board[0].price ?? null;
      }
    } catch { /* entry stays null; P/L recomputes from Alpaca */ }
  }

  await sql`
    INSERT INTO paper_trades
      (week_start, ticker, leaderboard_rank, entry_price, notional_usd, alpaca_order_id, status)
    VALUES (${weekStart}, ${ticker}, NULL, ${entryPrice}, ${TRADE_NOTIONAL_USD}, ${order?.id ?? null}, 'open')
  `;
  try {
    await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
      VALUES ('adhoc_buy', NULL, ${ticker}, NULL, 'bought', ${order?.id ? `order ${order.id} (ad-hoc buy)` : "ad-hoc buy"})`;
  } catch { /* logging must not block */ }
  return homeWith("adhoc_bought", ticker);
}
