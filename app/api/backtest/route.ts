import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { fetchJson, mapLimit, asRecord, num } from "@/lib/feed";

// Daily backtest / outcome tracking — the validation gate for real
// trading. For picks from exactly 7 days ago (first scan of that day),
// fetch daily candles for that ticker over the 7-day window and record:
// - outcome_pct: close on day 7 (or last available close) vs entry price
// - max_pct: highest daily high in the window vs entry price
// - hit_5: max_pct >= 5 (the target was "a 5% rise within 1 week", so
//   reaching +5% at any point in the window counts, not only closing there)
// Runs once a day via cron-job.org, CRON_SECRET-protected, like /api/weekly.
// First real outcomes land 7 days after the first scans (scans began
// 2026-10-26, so first outcomes 2026-11-02). Until then the table is
// empty, and the dashboard must say so — never a fabricated hit rate.
// Re-running for the same date is a no-op for already-stored tickers.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const sql = neon(process.env.DATABASE_URL!);
  const key = process.env.FINNHUB_KEY;
  if (!key) return NextResponse.json({ error: "no Finnhub key" }, { status: 503 });

  try {
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
  } catch {
    return NextResponse.json({ error: "could not create pick_outcomes table" }, { status: 500 });
  }

  const target = new Date();
  target.setUTCDate(target.getUTCDate() - 7);
  const targetDate = target.toISOString().slice(0, 10);

  let firstScan: any[] = [];
  try {
    firstScan = await sql`
      SELECT id FROM scans WHERE DATE(scanned_at) = ${targetDate} ORDER BY id ASC LIMIT 1
    `;
  } catch {
    firstScan = [];
  }
  if (firstScan.length === 0) {
    return NextResponse.json({ ok: true, targetDate, picks: 0, written: 0, note: "no scan on target date yet" });
  }
  const scanId = firstScan[0].id;
  let rows: any[] = [];
  try {
    rows = await sql`
      SELECT rank, ticker, score, catalyst, price
      FROM leaderboard WHERE scan_id = ${scanId} ORDER BY rank ASC LIMIT 50
    `;
  } catch {
    rows = [];
  }
  const from = Math.floor(new Date(`${targetDate}T00:00:00Z`).getTime() / 1000);
  const to = from + 8 * 24 * 3600;
  const results = await mapLimit(rows, 8, async (row: any) => {
    const entry = Number(row.price);
    if (!entry || entry <= 0) return null;
    const data = await fetchJson(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(row.ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`,
      6000,
    );
    const r = asRecord(data);
    if (!r || r.s !== "ok" || !Array.isArray(r.c) || r.c.length === 0) return null;
    const closes = (r.c as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined);
    const highs = Array.isArray(r.h)
      ? (r.h as unknown[]).map((v) => num(v)).filter((v): v is number => v !== undefined)
      : [];
    if (closes.length === 0) return null;
    const outcomePct = ((closes[closes.length - 1] - entry) / entry) * 100;
    const maxPct = highs.length > 0 ? ((Math.max(...highs) - entry) / entry) * 100 : outcomePct;
    return {
      ticker: row.ticker,
      rank: row.rank,
      score: row.score,
      catalyst: row.catalyst ? String(row.catalyst).split(":")[0] : null,
      entry,
      outcomePct,
      maxPct,
      hit: maxPct >= 5,
    };
  });

  let written = 0;
  for (const o of results) {
    if (!o) continue;
    try {
      await sql`
        INSERT INTO pick_outcomes
          (scan_date, ticker, rank, score, catalyst_type, entry_price, outcome_pct, max_pct, hit_5)
        VALUES (
          ${targetDate}, ${o.ticker}, ${o.rank}, ${o.score}, ${o.catalyst},
          ${o.entry}, ${o.outcomePct}, ${o.maxPct}, ${o.hit}
        )
        ON CONFLICT (scan_date, ticker) DO NOTHING
      `;
      written++;
    } catch {
      // One failed insert must not abort the rest.
    }
  }
  const hits = results.filter((o) => o && o.hit).length;
  const total = results.filter((o) => o !== null).length;
  return NextResponse.json({
    ok: true,
    targetDate,
    picks: rows.length,
    evaluated: total,
    written,
    hits,
    hitRatePct: total > 0 ? Math.round((hits / total) * 1000) / 10 : null,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
