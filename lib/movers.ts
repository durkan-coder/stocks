import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import {
  addDays,
  getCompanyNews,
  getEarningsCalendar,
  isoDate,
  mapLimit,
} from "@/lib/feed";
import { getUniverse } from "@/lib/universe";

// Shared missed-movers sweep, used by both routes:
//   /api/movers/daily  — run ONCE a day AFTER the close
//     (cron-job.org, 13:15 PT / 16:15 ET). Captures the close.
//   /api/movers/midday — run ONCE a day MIDDAY
//     (cron-job.org, 11:00 PT / 14:00 ET). Captures intraday
//     >= 5% moves that may recover by the close — the Nov 12
//     alerts (MRNA -5.17%, UAL -5.10% at ~11:00 PT, GPN
//     -10.40% at ~9:45 PT) were exactly this shape.
//
// Both write the same missed_movers rows (one per date+ticker,
// kept 30 days). A midday run and the close run share the row:
// the close run overwrites it with the close values, and a name
// that recovers below 5% by the close keeps its midday row —
// the close sweep only writes names still >= 5% then. A re-run
// the same day replaces today's rows, never duplicates.
//
// What it does: reads the staggered price_cache for every SPY
// name whose 1-day move is >= 5% in either direction (fresh
// rows only — the quotes job refreshes all 503 every 5
// minutes), then marks each one missed or on-board. "Missed by
// us" means the ticker was on NONE of today's weekly shortlist,
// latest leaderboard scan, open paper positions or today's
// proposals — the names the scanner never saw, like CHTR
// (+10.61% on Nov 10, four days after its Nov 6 report) and
// TTWO (+8.31%, the morning after its Nov 9 report on GTA VI
// preorders). An on-board name that fell (NVDA -5.47% on Nov 10
// while on the board) is recorded as on-board, not missed.
//
// The reason for each mover is built from verified parts only:
// whether it reported earnings in the last 7 days, plus its top
// company-news headline of the last 3 days, quoted verbatim. If
// neither exists the reason says so plainly ("no company news in
// the last 3 days and no earnings in the last 7 days") instead
// of inventing a cause. No LLM call — the headline is the reason
// in almost every case, and a deterministic quote cannot
// hallucinate. Paper data only; this never trades, proposes, or
// changes a score.
export async function runMoversSweep(req: NextRequest, run: "daily" | "midday") {
  const sql = neon(process.env.DATABASE_URL!);
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const now = new Date();
  const moverDate = now.toISOString().slice(0, 10);

  const movers = (await sql`
    SELECT ticker, price, change_pct FROM price_cache
    WHERE change_pct IS NOT NULL AND ABS(change_pct) >= 5
      AND updated_at > NOW() - INTERVAL '3 hours'
    ORDER BY ABS(change_pct) DESC
  `) as Array<{ ticker: string; price: number | null; change_pct: number | null }>;
  const freshRows = movers.length;

  // Today's board / holdings / proposals, for the missed flag.
  const onBoard = new Set<string>();
  try {
    const shortlist = (await sql`
      SELECT DISTINCT ticker FROM weekly_shortlist
      WHERE DATE(created_at) = CURRENT_DATE
    `) as Array<{ ticker: string }>;
    for (const r of shortlist) onBoard.add(String(r.ticker).toUpperCase());
  } catch {
    // A missing shortlist must not mark everything missed — the
    // leaderboard and holdings checks below still apply.
  }
  try {
    const latest = (await sql`SELECT id FROM scans ORDER BY id DESC LIMIT 1`) as Array<{ id: number }>;
    if (latest.length > 0) {
      const board = (await sql`
        SELECT DISTINCT ticker FROM leaderboard WHERE scan_id = ${latest[0].id}
      `) as Array<{ ticker: string }>;
      for (const r of board) onBoard.add(String(r.ticker).toUpperCase());
    }
  } catch {
    // Board check failure only — holdings/proposals still apply.
  }
  const held = new Set<string>();
  try {
    const open = (await sql`
      SELECT DISTINCT ticker FROM paper_trades WHERE status = 'open'
    `) as Array<{ ticker: string }>;
    for (const r of open) held.add(String(r.ticker).toUpperCase());
  } catch {
    // Holdings check failure only.
  }
  const proposedToday = new Set<string>();
  try {
    const props = (await sql`
      SELECT DISTINCT ticker FROM trade_proposals WHERE DATE(created_at) = CURRENT_DATE
    `) as Array<{ ticker: string }>;
    for (const r of props) proposedToday.add(String(r.ticker).toUpperCase());
  } catch {
    // Proposals check failure only.
  }

  // Earnings in the last 7 days, for the reason line.
  const reportedByTicker = new Map<string, string>();
  try {
    const pastEarnings = await getEarningsCalendar(isoDate(addDays(now, -7)), isoDate(now));
    for (const e of pastEarnings) reportedByTicker.set(e.symbol.toUpperCase(), e.date);
  } catch {
    // No earnings context — reasons fall back to headlines alone.
  }

  // Company names, best effort (static 503 fallback has them).
  const companyByTicker = new Map<string, string>();
  try {
    const universe = await getUniverse();
    for (const c of universe.list) companyByTicker.set(c.ticker.toUpperCase(), c.company ?? "");
  } catch {
    // Tickers still display without a company name.
  }

  // Top company-news headline per mover, last 3 days.
  const newsFrom = isoDate(addDays(now, -3));
  const newsPairs = await mapLimit(movers, 5, async (m) => {
    try {
      return { ticker: String(m.ticker).toUpperCase(), news: await getCompanyNews(String(m.ticker), newsFrom, isoDate(now)) };
    } catch {
      return { ticker: String(m.ticker).toUpperCase(), news: [] as Array<{ headline: string; source?: string | null }> };
    }
  });
  const newsByTicker = new Map(newsPairs.map((p) => [p.ticker, p.news]));

  try {
    await sql`CREATE TABLE IF NOT EXISTS missed_movers (
      id SERIAL PRIMARY KEY,
      mover_date DATE NOT NULL,
      ticker TEXT NOT NULL,
      company TEXT,
      move_pct NUMERIC NOT NULL,
      direction TEXT NOT NULL,
      missed BOOLEAN NOT NULL DEFAULT TRUE,
      reason TEXT,
      sources TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (mover_date, ticker)
    )`;
    await sql`DELETE FROM missed_movers WHERE mover_date < CURRENT_DATE - INTERVAL '30 days'`;
  } catch {
    return NextResponse.json({ ok: false, error: "missed_movers table unavailable" }, { status: 500 });
  }

  const rows: Array<{ ticker: string; movePct: number; direction: string; missed: boolean; reason: string }> = [];
  for (const m of movers) {
    const ticker = String(m.ticker).toUpperCase();
    const movePct = Number(m.change_pct);
    if (!Number.isFinite(movePct)) continue;
    const direction = movePct >= 0 ? "up" : "down";
    const missed = !onBoard.has(ticker) && !held.has(ticker) && !proposedToday.has(ticker);
    const reported = reportedByTicker.get(ticker);
    const news = newsByTicker.get(ticker) ?? [];
    const top = news.length > 0 ? news[0] : null;
    const parts: string[] = [];
    if (reported) parts.push(`Reported ${reported}.`);
    if (top) parts.push(top.headline);
    const reason =
      parts.length > 0
        ? parts.join(" ")
        : "No company news in the last 3 days and no earnings in the last 7 days — likely a macro/sector move.";
    const sources = top?.source ?? (reported ? "Finnhub earnings calendar" : null);
    await sql`
      INSERT INTO missed_movers (mover_date, ticker, company, move_pct, direction, missed, reason, sources)
      VALUES (${moverDate}, ${ticker}, ${companyByTicker.get(ticker) ?? null}, ${movePct}, ${direction}, ${missed}, ${reason}, ${sources})
      ON CONFLICT (mover_date, ticker) DO UPDATE SET
        company = EXCLUDED.company, move_pct = EXCLUDED.move_pct,
        direction = EXCLUDED.direction, missed = EXCLUDED.missed,
        reason = EXCLUDED.reason, sources = EXCLUDED.sources
    `;
    rows.push({ ticker, movePct, direction, missed, reason });
  }

  return NextResponse.json({
    ok: true,
    run,
    moverDate,
    freshRows,
    movers: rows.length,
    missed: rows.filter((r) => r.missed).length,
    onBoard: rows.filter((r) => !r.missed).length,
    rows,
    note:
      run === "midday"
        ? "Rows land on /scanner as 'Missed movers — ≥5% today' and on /movers. Run midday (~11:00 PT) to catch intraday ≥5% moves; the after-close run updates the same rows with the close values."
        : "Rows land on /scanner as 'Missed movers — ≥5% today' and on /movers. Run once a day after the close.",
  });
}
