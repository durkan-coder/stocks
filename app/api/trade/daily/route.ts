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
// Sells stay AUTOMATIC — waiting for a human to approve a stop-loss
// could let a +5% gain reverse or a -3% loss deepen. Human approval
// gates BUYS only.
//
// Buy guards (added 2026-10-30, Durkan-approved before the Mon Nov 2
// buy, after AAPL's valuation warnings and AMD's -12.5% day): a ticker
// is skipped, without changing its score or catalyst, when EITHER
//   (a) score floor: score < 50, or
//   (b) 1-day fall guard: change_1d_pct < -5%.
// The walk continues to the next ticker, so a guarded #1 does not
// block a passing #2. If every never-bought ticker is guarded, the run
// buys nothing and logs outcome "skipped_by_guard" with the reasons
// in detail, so the dashboard shows exactly why. A null 1-day change
// does not fail the fall guard (no proven fall); a null score fails
// the floor (no proven score >= 50). These guards use only fields
// already on the leaderboard row — no new feed, no premium endpoint.
//
// HUMAN-IN-THE-LOOP (added 2026-10-30, Durkan: approve trades):
// By default (trade_settings human_approval = 'on', or no setting
// row yet) this route does NOT place an order. It writes a
// trade_proposals row for the first candidate that passes the
// guards and returns it. The user approves or rejects it in the
// portfolio home (/), via /api/trade/approve or /api/trade/reject.
// Approval re-checks the guards against the CURRENT leaderboard
// row before placing the order, so a ticker that has since fallen
// or dropped in score cannot be approved on stale data. If
// human_approval is set to 'off' (toggle on /), this route buys
// directly as before. A proposal is only valid on the day it was
// created — an old pending proposal cannot be approved the next
// day, and a new daily run does not create a duplicate while
// today's proposal is still pending. No buy, and no proposal,
// happens for a ticker already bought before.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  // Recorded run (see externally_scheduled_job_diagnostics): cron-job.org
  // cannot be read by Muse, so every daily run writes its own record
  // to Neon — including runs that produce no trade — and the dashboard
  // shows the latest attempts. That distinguishes, from public data
  // alone, a run that never started (no attempt row) from a run that
  // started and failed (alpaca_buy_failed + detail) and from a run
  // that succeeded without a buy (skipped_all_bought / skipped_by_guard / proposal_created). No secrets are
  // ever written to the detail field: only outcome, ticker, rank,
  // scan id and the Alpaca error status/message.
  const logAttempt = async (outcome: string, scanId: number | null, ticker: string | null, rank: number | null, detail: string | null) => {
    try {
      await sql`CREATE TABLE IF NOT EXISTS trade_attempts (
        id SERIAL PRIMARY KEY,
        job TEXT NOT NULL DEFAULT 'trade_daily',
        scan_id INTEGER,
        ticker TEXT,
        leaderboard_rank INTEGER,
        outcome TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
        VALUES ('trade_daily', ${scanId}, ${ticker}, ${rank}, ${outcome}, ${detail})`;
    } catch {
      // Logging must never break the trade itself.
    }
  };

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      await logAttempt("unauthorized", null, null, null, null);
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const latest = await sql`
    SELECT id FROM scans ORDER BY id DESC LIMIT 1
  `;
  if (latest.length === 0) {
    await logAttempt("no_scan", null, null, null, null);
    return NextResponse.json({ ok: false, error: "no leaderboard scan yet" }, { status: 400 });
  }
  await logAttempt("started", latest[0].id, null, null, null);

  // Approval mode: 'on' by default, 'off' only if explicitly set.
  let approvalOn = true;
  try {
    await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const setting = await sql`SELECT value FROM trade_settings WHERE key = 'human_approval' LIMIT 1`;
    if (setting.length > 0) approvalOn = setting[0].value !== "off";
  } catch {
    approvalOn = true;
  }

  // Today's pending proposal, if any — do not create a duplicate.
  try {
    await sql`CREATE TABLE IF NOT EXISTS trade_proposals (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      leaderboard_rank INTEGER,
      score NUMERIC,
      price_at_proposal NUMERIC,
      catalyst TEXT,
      catalyst_type TEXT,
      event_date DATE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )`;
    if (approvalOn) {
      const pending = await sql`
        SELECT id, ticker, leaderboard_rank, score, price_at_proposal, catalyst, catalyst_type, event_date
        FROM trade_proposals
        WHERE status = 'pending' AND DATE(created_at) = CURRENT_DATE
        ORDER BY created_at DESC LIMIT 1
      `;
      if (pending.length > 0) {
        const p = pending[0];
        await logAttempt("proposal_exists", latest[0].id, p.ticker, p.leaderboard_rank, null);
        return NextResponse.json({ ok: true, weekStart: null, bought: null, proposal: p, note: "today's proposal is still pending human approval — no duplicate created" });
      }
    }
  } catch {
    // Proposal table failure must not block an auto-buy when approval is off;
    // when approval is on, the proposal insert below will surface the error.
  }

  const rows = await sql`
    SELECT rank, ticker, price, score, change_1d_pct, catalyst, sentiment, reasoning
    FROM leaderboard
    WHERE scan_id = ${latest[0].id} ORDER BY rank ASC
  `;

  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay();
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  // Find the first candidate: never bought before, passing guards.
  const guarded: string[] = [];
  let candidate: any = null;
  for (const row of rows) {
    const ticker = row.ticker as string;
    const prior = await sql`
      SELECT id FROM paper_trades WHERE ticker = ${ticker} LIMIT 1
    `;
    if (prior.length > 0) continue; // already bought before — next in sequence
    const score = row.score === null || row.score === undefined ? null : Number(row.score);
    const change1d = row.change_1d_pct === null || row.change_1d_pct === undefined ? null : Number(row.change_1d_pct);
    const reasons: string[] = [];
    if (score === null || score < 50) reasons.push(`score ${score === null ? "null" : score} < 50`);
    if (change1d !== null && change1d < -5) reasons.push(`1d ${change1d}% < -5%`);
    if (reasons.length > 0) {
      guarded.push(`${ticker} rank ${row.rank} (${reasons.join(", ")})`);
      continue;
    }
    candidate = row;
    break;
  }

  if (!candidate) {
    if (guarded.length > 0) {
      const detail = `guarded: ${guarded.join("; ")}`.slice(0, 300);
      await logAttempt("skipped_by_guard", latest[0].id, null, null, detail);
      return NextResponse.json({
        ok: true,
        weekStart,
        bought: null,
        guarded,
        note: "every never-bought leaderboard ticker failed a buy guard (score < 50 or 1-day fall < -5%) — nothing bought today",
      });
    }
    await logAttempt("skipped_all_bought", latest[0].id, null, null, null);
    return NextResponse.json({
      ok: true,
      weekStart,
      bought: null,
      note: "every leaderboard ticker has already been bought — nothing bought today",
    });
  }

  const ticker = candidate.ticker as string;

  // Human-in-the-loop: propose, do not buy.
  if (approvalOn) {
    // Event date / type from the latest shortlist row for context
    // on the proposal card (e.g. "earnings in 2 days").
    let eventDate: string | null = null;
    let catalystType: string | null = null;
    try {
      const s = await sql`
        SELECT event_date, catalyst_type FROM weekly_shortlist
        WHERE ticker = ${ticker} ORDER BY created_at DESC LIMIT 1
      `;
      if (s.length > 0) {
        eventDate = s[0].event_date ? new Date(s[0].event_date).toISOString().slice(0, 10) : null;
        catalystType = s[0].catalyst_type ?? null;
      }
    } catch {
      // Context only — a missing event date must not block the proposal.
    }
    const inserted = await sql`
      INSERT INTO trade_proposals
        (ticker, leaderboard_rank, score, price_at_proposal, catalyst, catalyst_type, event_date, status)
      VALUES (${ticker}, ${candidate.rank}, ${candidate.score ?? null}, ${candidate.price ?? null}, ${candidate.catalyst ?? null}, ${catalystType}, ${eventDate}, 'pending')
      RETURNING id, ticker, leaderboard_rank, score, price_at_proposal, catalyst, catalyst_type, event_date
    `;
    const proposal = inserted[0];
    await logAttempt("proposal_created", latest[0].id, ticker, candidate.rank, `score ${candidate.score ?? "—"}, price ${candidate.price ?? "—"}`);
    return NextResponse.json({
      ok: true,
      weekStart,
      bought: null,
      proposal,
      note: "human approval required — no order placed. Approve or reject in the portfolio home.",
    });
  }

  // Approval off: direct buy, as before.
  let order: any;
  try {
    order = await placeNotionalBuy(ticker, TRADE_NOTIONAL_USD);
  } catch (e: any) {
    const detail = String(e?.message ?? e).slice(0, 300);
    await logAttempt("alpaca_buy_failed", latest[0].id, ticker, candidate.rank, detail);
    return NextResponse.json(
      { ok: false, error: "alpaca_buy_failed", ticker, detail },
      { status: 502 },
    );
  }
  await logAttempt("bought", latest[0].id, ticker, candidate.rank, order?.id ? `order ${order.id}` : null);
  await sql`
    INSERT INTO paper_trades
      (week_start, ticker, leaderboard_rank, entry_price, notional_usd, alpaca_order_id, status)
    VALUES (${weekStart}, ${ticker}, ${candidate.rank}, ${candidate.price ?? null}, ${TRADE_NOTIONAL_USD}, ${order?.id ?? null}, 'open')
  `;
  return NextResponse.json({
    ok: true,
    weekStart,
    bought: { ticker, rank: candidate.rank, notional: TRADE_NOTIONAL_USD, orderId: order?.id ?? null },
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
