import { neon } from "@neondatabase/serverless";
import { NextResponse } from "next/server";

// Frontend data feed: latest scan only, ordered by rank.
export const dynamic = "force-dynamic";

export async function GET() {
  const sql = neon(process.env.DATABASE_URL!);
  const scans = await sql`SELECT id, scanned_at, market_status FROM scans ORDER BY id DESC LIMIT 1`;
  if (scans.length === 0) {
    return NextResponse.json({ scan: null, rows: [] });
  }
  const scan = scans[0];
  const rows = await sql`
    SELECT rank, ticker, company, price, change_1d_pct, change_5d_pct,
           volume_ratio, score, catalyst, sentiment, reasoning, sources,
           confidence, target_pct, scanned_at
    FROM leaderboard
    WHERE scan_id = ${scan.id}
    ORDER BY rank ASC
  `;
  return NextResponse.json({ scan, rows });
}
