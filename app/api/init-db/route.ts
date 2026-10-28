import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";

// One-time database setup, run instead of pasting SQL in Neon manually.
// Protected by CRON_SECRET, same as /api/scan. It only creates tables
// that do not already exist — it never drops, truncates, or alters data.
// Trigger once with: POST /api/init-db with Authorization: Bearer CRON_SECRET
// After it returns ok:true, /api/leaderboard should stop returning 500
// (it will return an empty scan list until the first scan runs).
export const dynamic = "force-dynamic";

// Each statement is a separate template-literal call: the Neon serverless
// driver's sql function has no .query() method, so dynamic strings fail
// type-checking at build time. Statements are inlined in POST (not a
// helper) because ReturnType<typeof neon> does not match the concrete
// NeonQueryFunction<false, false> type and breaks the build.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const sql = neon(process.env.DATABASE_URL!);
  await sql`CREATE TABLE IF NOT EXISTS scans (
    id SERIAL PRIMARY KEY,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_status TEXT NOT NULL,
    universe TEXT NOT NULL DEFAULT 'SPY constituents (S&P 500)',
    notes TEXT
  )`;
  await sql`CREATE TABLE IF NOT EXISTS leaderboard (
    id SERIAL PRIMARY KEY,
    scan_id INTEGER NOT NULL REFERENCES scans(id),
    scanned_at TIMESTAMPTZ NOT NULL,
    rank INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    company TEXT,
    price NUMERIC,
    change_1d_pct NUMERIC,
    change_5d_pct NUMERIC,
    volume_ratio NUMERIC,
    score NUMERIC NOT NULL,
    catalyst TEXT,
    sentiment TEXT,
    reasoning TEXT NOT NULL,
    sources TEXT,
    confidence TEXT NOT NULL DEFAULT 'watch',
    target_pct NUMERIC NOT NULL DEFAULT 5.0
  )`;
  await sql`CREATE TABLE IF NOT EXISTS weekly_shortlist (
    id SERIAL PRIMARY KEY,
    week_start DATE NOT NULL,
    ticker TEXT NOT NULL,
    company TEXT,
    catalyst_type TEXT NOT NULL,
    event_date DATE,
    event_detail TEXT,
    reasoning TEXT NOT NULL,
    score NUMERIC NOT NULL,
    sources TEXT,
    is_new BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS paper_trades (
    id SERIAL PRIMARY KEY,
    week_start DATE NOT NULL,
    ticker TEXT NOT NULL,
    leaderboard_rank INTEGER,
    entry_price NUMERIC,
    notional_usd NUMERIC NOT NULL DEFAULT 100,
    alpaca_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    exit_price NUMERIC,
    pnl_pct NUMERIC,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
  )`;
  await sql`CREATE TABLE IF NOT EXISTS llm_screen (
    id SERIAL PRIMARY KEY,
    screen_date DATE NOT NULL,
    rank INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    reason TEXT NOT NULL,
    catalyst_type TEXT,
    event_date DATE,
    rsi14 NUMERIC,
    month_pct NUMERIC,
    volume_ratio NUMERIC,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS pick_outcomes (
    id SERIAL PRIMARY KEY,
    scan_date DATE NOT NULL,
    ticker TEXT NOT NULL,
    rank INTEGER,
    score NUMERIC,
    catalyst_type TEXT,
    entry_price NUMERIC NOT NULL,
    outcome_pct NUMERIC,
    max_pct NUMERIC,
    hit_5 BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scan_date, ticker)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS macro_events (
    id SERIAL PRIMARY KEY,
    event_date DATE NOT NULL,
    event TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leaderboard_scanned_at ON leaderboard(scanned_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_weekly_score ON weekly_shortlist(week_start DESC, score DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status, opened_at DESC)`;
  return NextResponse.json({ ok: true, tables: ["scans", "leaderboard", "weekly_shortlist", "paper_trades", "llm_screen", "pick_outcomes", "macro_events"] });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
