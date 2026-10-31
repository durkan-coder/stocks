import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { placeNotionalBuy, TRADE_NOTIONAL_USD } from "@/lib/alpaca";
import { isPinValid } from "@/lib/approvalPin";

// Approve a pending trade proposal (human-in-the-loop buy).
// Called from the portfolio home's Approve button (a plain form
// POST, so the browser returns to / afterwards). Paper only, $100.
//
// Safety, in order:
//  1. Proposal must exist, be 'pending', and be from TODAY — an
//     old proposal cannot be approved on stale intent/price.
//  2. Ticker must never have been bought before (paper_trades).
//  3. Guards are RE-CHECKED against the CURRENT leaderboard row
//     (score >= 50, 1-day change > -5%). If it now fails, the
//     proposal is marked 'guarded' and no order is placed.
//  4. Only then is the Alpaca order placed, at the CURRENT market
//     price for $100 notional (the proposal price is a reference,
//     not a limit — a market order cannot guarantee it).
// Sells are NOT gated here: /api/trade/check still closes at
// +5% / -3% automatically.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let proposalId: number | null = null;
  let pin: string | null = null;
  try {
    const form = await req.formData();
    proposalId = Number(form.get("proposalId"));
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      proposalId = Number(body.proposalId);
      pin = body.pin ? String(body.pin) : null;
    } catch {
      proposalId = null;
    }
  }
  const home = new URL("/", req.url);
  // PIN gate, before any trade action: fail closed if APPROVAL_PIN
  // is unset or the PIN does not match. Never log the PIN value.
  if (!isPinValid(pin)) {
    return NextResponse.redirect(home);
  }
  if (!proposalId || !Number.isFinite(proposalId)) {
    return NextResponse.redirect(home);
  }

  const full = await sql`
    SELECT id, ticker, leaderboard_rank, status, created_at, price_at_proposal
    FROM trade_proposals WHERE id = ${proposalId} LIMIT 1
  `;
  if (full.length === 0) return NextResponse.redirect(home);
  const row = full[0];
  const proposal = row;
  if (row.status !== "pending") return NextResponse.redirect(home);
  if (new Date(row.created_at).toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
    await sql`UPDATE trade_proposals SET status = 'expired', decided_at = NOW() WHERE id = ${proposalId}`;
    return NextResponse.redirect(home);
  }

  const ticker = row.ticker as string;
  const prior = await sql`SELECT id FROM paper_trades WHERE ticker = ${ticker} LIMIT 1`;
  if (prior.length > 0) {
    await sql`UPDATE trade_proposals SET status = 'superseded', decided_at = NOW() WHERE id = ${proposalId}`;
    return NextResponse.redirect(home);
  }

  // Guard re-check against the latest scan row.
  const latest = await sql`SELECT id FROM scans ORDER BY id DESC LIMIT 1`;
  if (latest.length > 0) {
    const board = await sql`
      SELECT score, change_1d_pct, price FROM leaderboard
      WHERE scan_id = ${latest[0].id} AND ticker = ${ticker} LIMIT 1
    `;
    if (board.length > 0) {
      const score = board[0].score === null ? null : Number(board[0].score);
      const change1d = board[0].change_1d_pct === null ? null : Number(board[0].change_1d_pct);
      if (score === null || score < 50 || (change1d !== null && change1d < -5)) {
        await sql`UPDATE trade_proposals SET status = 'guarded', decided_at = NOW() WHERE id = ${proposalId}`;
        try {
          await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
            VALUES ('trade_daily', ${latest[0].id}, ${ticker}, ${row.leaderboard_rank}, 'proposal_guarded_on_approve', ${`score ${score}, 1d ${change1d}`})`;
        } catch { /* logging must not block */ }
        return NextResponse.redirect(home);
      }
    }
  }

  let order: any;
  try {
    order = await placeNotionalBuy(ticker, TRADE_NOTIONAL_USD);
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 300);
    try {
      await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
        VALUES ('trade_daily', ${latest.length > 0 ? latest[0].id : null}, ${ticker}, ${row.leaderboard_rank}, 'alpaca_buy_failed', ${detail})`;
    } catch { /* logging must not block */ }
    // Leave the proposal pending so the user can retry approval
    // after fixing the cause (e.g. Alpaca outage), rather than
    // silently dropping a human-approved trade.
    return NextResponse.redirect(home);
  }

  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay();
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  // Entry price: use the proposal price if the latest board price
  // is unavailable; the Alpaca fill price is the authoritative one
  // and the positions screen recomputes P/L from Alpaca anyway.
  let entryPrice: number | null = null;
  if (latest.length > 0) {
    const board = await sql`
      SELECT price FROM leaderboard WHERE scan_id = ${latest[0].id} AND ticker = ${ticker} LIMIT 1
    `;
    if (board.length > 0) entryPrice = board[0].price ?? proposal.price_at_proposal ?? null;
  }
  if (entryPrice === null) entryPrice = proposal.price_at_proposal ?? null;

  await sql`
    INSERT INTO paper_trades
      (week_start, ticker, leaderboard_rank, entry_price, notional_usd, alpaca_order_id, status)
    VALUES (${weekStart}, ${ticker}, ${row.leaderboard_rank}, ${entryPrice}, ${TRADE_NOTIONAL_USD}, ${order?.id ?? null}, 'open')
  `;
  await sql`UPDATE trade_proposals SET status = 'approved', decided_at = NOW() WHERE id = ${proposalId}`;
  try {
    await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
      VALUES ('trade_daily', ${latest.length > 0 ? latest[0].id : null}, ${ticker}, ${row.leaderboard_rank}, 'bought', ${order?.id ? `order ${order.id} (human-approved)` : "human-approved"})`;
  } catch { /* logging must not block */ }
  return NextResponse.redirect(home);
}
