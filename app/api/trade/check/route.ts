import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { closePosition, getPositions, shouldSell } from "@/lib/alpaca";

// Threshold check: run every 15 minutes alongside /api/scan (cron-job.org).
// For each open paper trade, look up its Alpaca position's unrealised
// P/L percent against the +3% take-profit / -2% stop-loss levels.
//
// MANUAL ONLY (2026-11-09, user's choice): automatic sells are OFF
// by default. When the 'auto_sell' setting is off (or unset), this
// route SELLS NOTHING — it only watches the thresholds and records
// each active crossing in sell_alerts (one row per ticker + trigger,
// first seen / last seen, resolved when the price moves back inside
// range), so a notification channel can pick it up. Turn automatic
// sells back on from the portfolio home toggle (auto_sell = 'on').
// Relaxed 2026-10-31 from +5% / -3%.
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

  // Tax-reserve (SGOV) rows are the parking vehicle, not trading
  // positions: the +3% / -2% levels never apply to them and this
  // route must never sell them. The column may not exist yet on
  // the first run after deploy, so create it idempotently first.
  try {
    await sql`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_tax_reserve BOOLEAN NOT NULL DEFAULT false`;
  } catch { /* stock rows are treated as non-reserve below */ }

  // Check the DB first: with no open trades there is nothing to check,
  // so do NOT call Alpaca at all. Previously this route called Alpaca
  // unconditionally, so a bad Alpaca key / Alpaca outage made even an
  // empty check return 500 instead of a clean "nothing to do".
  const open = await sql`
    SELECT id, ticker FROM paper_trades
    WHERE status = 'open' AND (is_tax_reserve IS NULL OR is_tax_reserve = false)
    ORDER BY opened_at ASC
  `;
  if (open.length === 0) {
    return NextResponse.json({ ok: true, autoSell: false, closed: [], stillOpen: [], watching: [], note: "no open paper trades — Alpaca not called" });
  }

  // Automatic sells: OFF unless the user explicitly turned them on
  // in the portfolio home (trade_settings key 'auto_sell' = 'on').
  // Missing row = off (manual-only default since 2026-11-09).
  let autoSell = false;
  try {
    const s = await sql`SELECT value FROM trade_settings WHERE key = 'auto_sell' LIMIT 1`;
    if (s.length > 0) autoSell = s[0].value === "on";
  } catch {
    autoSell = false;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS sell_alerts (
      ticker TEXT NOT NULL,
      trigger TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      PRIMARY KEY (ticker, trigger)
    )
  `;

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
  const watching = [];
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
      // Back inside range: resolve any open alert for this ticker.
      try {
        await sql`UPDATE sell_alerts SET resolved_at = NOW() WHERE ticker = ${ticker} AND resolved_at IS NULL`;
      } catch { /* alert bookkeeping must not block the check */ }
      stillOpen.push({ ticker, plpc });
      continue;
    }
    if (!autoSell) {
      // Manual only: record the crossing, sell nothing.
      try {
        await sql`
          INSERT INTO sell_alerts (ticker, trigger) VALUES (${ticker}, ${action})
          ON CONFLICT (ticker, trigger) DO UPDATE SET last_seen_at = NOW(), resolved_at = NULL
        `;
      } catch { /* alert bookkeeping must not block the check */ }
      watching.push({ ticker, trigger: action, plpc });
      stillOpen.push({ ticker, plpc, note: `past ${action === "take_profit" ? "+3% take-profit" : "-2% stop-loss"} — manual sell only, alert recorded` });
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
    try {
      await sql`UPDATE sell_alerts SET resolved_at = NOW() WHERE ticker = ${ticker} AND resolved_at IS NULL`;
    } catch { /* alert bookkeeping must not block the check */ }
    closed.push({ ticker, action, plpc, exitPrice: Number(pos.current_price) });
  }

  return NextResponse.json({ ok: true, autoSell, closed, stillOpen, watching });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
