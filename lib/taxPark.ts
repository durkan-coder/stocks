// Tax parking: turn the tax reserve from a ledger number into a
// REAL money market position, following the same buy pattern as a
// stock buy — a real Alpaca paper market order, notional-based,
// fractional shares, recorded as a paper_trades row so it shows in
// Open positions, the portfolio value, and the journal.
//
// Instrument: SGOV (iShares 0-3 Month Treasury Bond ETF). It holds
// US Treasury bills maturing in 0-3 months, its price sits near
// $100 and barely moves, and it pays a monthly dividend — the
// standard "park cash safely" ETF, and the closest thing to a money
// market fund Alpaca can buy (Alpaca has no MMF product). If the
// user wants BIL or another T-bill ETF instead, change the one
// constant below.
//
// How it works:
//  - After every sale, sweepTaxReserve() runs: tax owed on this
//    year's realized gains (lib/tax.ts, netted, 40.8% ST / 23.8%
//    LT) minus what is already parked in SGOV (buy notionals)
//    plus what was withdrawn (proceeds of closed SGOV rows, i.e.
//    money taken out to pay a tax bill) = un-parked amount.
//  - If that amount is >= $1 (Alpaca's fractional minimum), buy
//    SGOV for exactly that amount. Smaller slices stay "awaiting
//    parking" and are swept on the next sale / Park-now tap, when
//    they add up to $1.
//  - The sweep NEVER throws: a failed park (e.g. Alpaca rejection
//    after market hours — market orders need market hours) is
//    recorded as park_failed and the amount stays awaiting
//    parking. A failed park must never fail the sale that
//    triggered it.
//  - SGOV rows are excluded from the sell-check (+3% / -2% never
//    applies to the parking vehicle) and from the tax summary
//    (selling SGOV to pay taxes creates no new tax).
//  - Selling an SGOV position from the home Sell button is how
//    the parked money is withdrawn at tax time.

import { getPositions, placeParkBuy, TAX_PARK_MIN_NOTIONAL_USD } from "@/lib/alpaca";
import { computeTaxSummary, tradeProceedsUsd } from "@/lib/tax";

export const TAX_PARK_TICKER = "SGOV";
export const TAX_PARK_MIN_USD = TAX_PARK_MIN_NOTIONAL_USD; // $1

export async function ensureTaxReserveColumn(sql: any): Promise<void> {
  try {
    await sql`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_tax_reserve BOOLEAN NOT NULL DEFAULT false`;
  } catch {
    // If the column cannot be added, callers treat every row as a
    // stock row; the sweep below will fail safe on its own checks.
  }
}

// Pure math, exported for testing: how much tax is still un-parked.
export function unparkedAmount(taxOwed: number, parkedCost: number, withdrawnProceeds: number): number {
  return Math.max(0, taxOwed - parkedCost + withdrawnProceeds);
}

export interface ReserveStatus {
  taxOwed: number;
  parkedCost: number; // sum of SGOV buy notionals (open + closed)
  withdrawnProceeds: number; // proceeds of closed SGOV rows
  unparked: number;
}

export async function reserveStatus(sql: any, taxYear = new Date().getFullYear()): Promise<ReserveStatus> {
  await ensureTaxReserveColumn(sql);
  const closed = await sql`
    SELECT ticker, entry_price, exit_price, pnl_pct, notional_usd, opened_at, closed_at, is_tax_reserve
    FROM paper_trades
    WHERE status <> 'open' AND closed_at IS NOT NULL
      AND EXTRACT(YEAR FROM closed_at) = ${taxYear}
  `;
  const tax = computeTaxSummary(closed as any[]);
  const parked = await sql`
    SELECT notional_usd, pnl_pct, entry_price, exit_price, status
    FROM paper_trades WHERE ticker = ${TAX_PARK_TICKER} AND is_tax_reserve = true
  `;
  let parkedCost = 0;
  let withdrawnProceeds = 0;
  for (const r of parked) {
    const n = Number(r.notional_usd ?? 0);
    if (!Number.isFinite(n)) continue;
    parkedCost += n;
    if (r.status !== "open") {
      const p = tradeProceedsUsd(r as any);
      if (p !== null) withdrawnProceeds += p;
    }
  }
  return {
    taxOwed: tax.taxOwed,
    parkedCost,
    withdrawnProceeds,
    unparked: unparkedAmount(tax.taxOwed, parkedCost, withdrawnProceeds),
  };
}

export interface SweepResult {
  parked: number; // dollars actually bought (0 if nothing)
  orderId: string | null;
  reason: string; // "parked" | "nothing_owed" | "below_minimum" | "alpaca_failed" | "record_failed"
}

export async function sweepTaxReserve(sql: any): Promise<SweepResult> {
  try {
    const status = await reserveStatus(sql);
    if (status.unparked < 0.005) return { parked: 0, orderId: null, reason: "nothing_owed" };
    if (status.unparked < TAX_PARK_MIN_USD) return { parked: 0, orderId: null, reason: "below_minimum" };
    const amount = Math.floor(status.unparked * 100) / 100;

    let order: any;
    try {
      order = await placeParkBuy(TAX_PARK_TICKER, amount);
    } catch (e: any) {
      const detail = String(e?.message ?? e).slice(0, 300);
      try {
        await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
          VALUES ('tax_park', NULL, ${TAX_PARK_TICKER}, NULL, 'park_failed', ${detail})`;
      } catch { /* logging must not block */ }
      return { parked: 0, orderId: null, reason: "alpaca_failed" };
    }

    // Entry price: the Alpaca position's average entry is the
    // authoritative fill price; fall back to the order's filled
    // average, then to the current SGOV price.
    let entryPrice: number | null = null;
    try {
      const positions = await getPositions();
      const pos = positions.find((p: any) => p.symbol === TAX_PARK_TICKER);
      if (pos) entryPrice = Number(pos.avg_entry_price);
    } catch { /* fall through to the order fields */ }
    if (entryPrice === null || !Number.isFinite(entryPrice)) {
      const filled = Number(order?.filled_avg_price ?? NaN);
      entryPrice = Number.isFinite(filled) ? filled : null;
    }

    const now = new Date();
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);
    try {
      await sql`
        INSERT INTO paper_trades
          (week_start, ticker, leaderboard_rank, entry_price, notional_usd, alpaca_order_id, status, is_tax_reserve)
        VALUES (${weekStart}, ${TAX_PARK_TICKER}, NULL, ${entryPrice}, ${amount}, ${order?.id ?? null}, 'open', true)
      `;
    } catch (e: any) {
      // The buy happened at Alpaca but the row could not be
      // recorded: log it loudly in trade_attempts so the money is
      // not silently untracked (Alpaca positions still show it).
      try {
        await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
          VALUES ('tax_park', NULL, ${TAX_PARK_TICKER}, NULL, 'record_failed', ${`order ${order?.id ?? "?"} $${amount} — row insert failed: ${String(e?.message ?? e).slice(0, 200)}`})`;
      } catch { /* logging must not block */ }
      return { parked: 0, orderId: order?.id ?? null, reason: "record_failed" };
    }
    try {
      await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
        VALUES ('tax_park', NULL, ${TAX_PARK_TICKER}, NULL, 'parked', ${`order ${order?.id ?? "?"} $${amount.toFixed(2)} SGOV for tax reserve`})`;
    } catch { /* logging must not block */ }
    return { parked: amount, orderId: order?.id ?? null, reason: "parked" };
  } catch {
    return { parked: 0, orderId: null, reason: "alpaca_failed" };
  }
}
