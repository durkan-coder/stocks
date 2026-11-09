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

import { getLatestTradePrice, getOrder, getPositions, placeParkBuy, TAX_PARK_MIN_NOTIONAL_USD } from "@/lib/alpaca";
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

// Repair open SGOV rows whose entry price was never recorded
// (a park buy placed after hours, before extended_hours, had no
// fill price and no live position yet, so entry_price stayed null
// and the position rendered as a row of dashes). For each such
// row: if its Alpaca order filled, use the fill price; if the
// order is still live, use the latest quote as a pending-fill
// entry (SGOV barely moves); if the order died, delete the row —
// the buy never happened, so the money returns to "awaiting
// parking" and the next sweep re-parks it. Never throws.
export async function repairParkedEntries(sql: any): Promise<void> {
  try {
    await ensureTaxReserveColumn(sql);
    const rows = await sql`
      SELECT id, alpaca_order_id FROM paper_trades
      WHERE ticker = ${TAX_PARK_TICKER} AND is_tax_reserve = true
        AND status = 'open' AND entry_price IS NULL
    `;
    for (const r of rows) {
      try {
        const orderId = r.alpaca_order_id as string | null;
        let entry: number | null = null;
        let dead = false;
        if (orderId) {
          try {
            const o = await getOrder(orderId);
            const st = String(o?.status ?? "");
            if (st === "filled") {
              const f = Number(o?.filled_avg_price);
              entry = Number.isFinite(f) ? f : null;
            } else if (st === "canceled" || st === "expired" || st === "rejected") {
              dead = true;
            }
          } catch { /* fall through to the quote */ }
        }
        if (dead) {
          await sql`DELETE FROM paper_trades WHERE id = ${r.id}`;
          try {
            await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
              VALUES ('tax_park', NULL, ${TAX_PARK_TICKER}, NULL, 'park_order_dead', ${`order ${orderId} died before filling — row removed, amount returns to awaiting parking`})`;
          } catch { /* logging must not block */ }
          continue;
        }
        if (entry === null) entry = await getLatestTradePrice(TAX_PARK_TICKER);
        if (entry !== null && Number.isFinite(entry)) {
          await sql`UPDATE paper_trades SET entry_price = ${entry} WHERE id = ${r.id}`;
        }
      } catch { /* one bad row must not block the rest */ }
    }
  } catch { /* repair must never break the caller */ }
}

export async function sweepTaxReserve(sql: any): Promise<SweepResult> {
  try {
    await repairParkedEntries(sql);
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

    // Entry price: the order's fill price first, then the live
    // position's average entry, then the latest quote (a buy that
    // has not filled yet — e.g. placed just now — still needs an
    // entry price, or the row renders blank). SGOV barely moves,
    // so the quote is within pennies of the eventual fill, and
    // repairParkedEntries() corrects it to the real fill price
    // once the order fills.
    let entryPrice: number | null = null;
    const filled = Number(order?.filled_avg_price ?? NaN);
    if (Number.isFinite(filled)) entryPrice = filled;
    if (entryPrice === null) {
      try {
        const positions = await getPositions();
        const pos = positions.find((p: any) => p.symbol === TAX_PARK_TICKER);
        if (pos) {
          const avg = Number(pos.avg_entry_price);
          if (Number.isFinite(avg)) entryPrice = avg;
        }
      } catch { /* fall through to the quote */ }
    }
    if (entryPrice === null) entryPrice = await getLatestTradePrice(TAX_PARK_TICKER);

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
