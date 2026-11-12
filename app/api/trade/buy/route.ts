import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import {
  ADHOC_BUY_MAX_USD,
  ADHOC_BUY_MIN_USD,
  getLatestTradePrice,
  placeAdhocBuy,
} from "@/lib/alpaca";
import { isPinValid } from "@/lib/approvalPin";

// Ad-hoc buy (added 2026-11-12, Durkan: "a way to buy a stock on
// adhoc basis"; extended 2026-11-12 with company search, custom
// amount and accumulating): buy any ticker the user types, on
// demand, from the portfolio home — outside the daily leaderboard
// flow. The form lets the user type a company name (resolved to
// a ticker by /api/ticker/search) or a ticker directly, pick the
// amount ($1–$10,000, default $100), and buy.
//
// Safety, in order:
//  1. PIN gate (fail closed if APPROVAL_PIN is unset or wrong).
//  2. Ticker must be a plausible symbol (letters/digits, one dot).
//  3. Amount must be $1–$10,000 (Alpaca minimum to paper capital).
//  4. No score/fall guards and no daily cap: this is the user's
//     explicit call, not the scanner's pick. Previously bought and
//     closed tickers CAN be re-bought here.
//  5. ACCUMULATING IS ALLOWED: buying a ticker that already has
//     an open row inserts a SECOND paper_trades row (a separate
//     lot), instead of refusing. Selling closes the whole Alpaca
//     position for that ticker at once, so /api/trade/sell closes
//     ALL open lots of the ticker together — one row per lot is
//     kept so each lot's entry, P/L and tax stay honest.
//  6. Market order at the current price, same as an approval.
//     Entry price is the latest trade quote (falling back to the
//     board price); P/L is recomputed from Alpaca.
// Paper only, same as every other buy.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let tickerRaw: string | null = null;
  let pin: string | null = null;
  let amountRaw: string | null = null;
  try {
    const form = await req.formData();
    tickerRaw = form.get("ticker") ? String(form.get("ticker")) : null;
    pin = form.get("pin") ? String(form.get("pin")) : null;
    amountRaw = form.get("amount") ? String(form.get("amount")) : null;
  } catch {
    try {
      const body = await req.json();
      tickerRaw = body.ticker ? String(body.ticker) : null;
      pin = body.pin ? String(body.pin) : null;
      amountRaw = body.amount !== undefined && body.amount !== null ? String(body.amount) : null;
    } catch {
      tickerRaw = null;
    }
  }
  // Redirect home WITH a visible result notice (same pattern as
  // approve/reject/sell): a failed PIN, a bad amount, or a rejected
  // order must not look identical to a successful buy.
  const homeWith = (notice: string, ticker?: string, amount?: number) => {
    const u = new URL("/", req.url);
    u.searchParams.set("notice", notice);
    if (ticker) u.searchParams.set("ticker", ticker);
    if (amount !== undefined) u.searchParams.set("amount", String(amount));
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
  const amount = Math.round(Number(amountRaw) * 100) / 100;
  if (!Number.isFinite(amount) || amount < ADHOC_BUY_MIN_USD || amount > ADHOC_BUY_MAX_USD) {
    return homeWith("buy_amount_invalid", ticker);
  }

  let order: any;
  try {
    order = await placeAdhocBuy(ticker, amount);
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
    VALUES (${weekStart}, ${ticker}, NULL, ${entryPrice}, ${amount}, ${order?.id ?? null}, 'open')
  `;
  try {
    await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
      VALUES ('adhoc_buy', NULL, ${ticker}, NULL, 'bought', ${order?.id ? `order ${order.id} (ad-hoc buy $${amount})` : `ad-hoc buy $${amount}`})`;
  } catch { /* logging must not block */ }
  return homeWith("adhoc_bought", ticker, amount);
}
