import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { selectTop50, type CatalystEvent } from "@/lib/weekly";

// Stage 1, run EVERY DAY via cron-job.org (e.g. pre-market ET).
// The 1-week horizon stays the same — the event must be within the
// coming 7 days — but the list is rebuilt daily so a stock that gains
// a new catalyst is added the same day, not next week, and flagged is_new.
// Same CRON_SECRET protection as /api/scan.
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

  // TODO: replace with the real daily catalyst feed:
  // earnings calendar + macro calendar + news/geopolitical scan.
  // Until then, write nothing rather than a fake 50.
  const events: CatalystEvent[] = [];
  const top50 = selectTop50(events);

  // Week starting Monday (UTC date) — kept for grouping; the rebuild
  // itself is daily, keyed by created_at in the queries.
  const now = new Date();
  const monday = new Date(now);
  const day = now.getUTCDay(); // 0 = Sunday
  monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);

  // New-ticker detection: tickers in today's top 50 that were NOT in
  // any earlier shortlist. These are what the user wants to spot.
  let previous = new Set<string>();
  try {
    const prevRows = await sql`
      SELECT DISTINCT ticker FROM weekly_shortlist
      WHERE DATE(created_at) < CURRENT_DATE
    `;
    previous = new Set(prevRows.map((r: any) => r.ticker as string));
  } catch {
    previous = new Set();
  }
  const newTickers = top50.filter((e) => !previous.has(e.ticker)).map((e) => e.ticker);

  for (const e of top50) {
    await sql`
      INSERT INTO weekly_shortlist
        (week_start, ticker, company, catalyst_type, event_date,
         event_detail, reasoning, score, sources, is_new)
      VALUES (
        ${weekStart}, ${e.ticker}, ${e.company ?? null}, ${e.type},
        ${e.eventDate ?? null}, ${e.detail}, ${e.detail}, ${e.score},
        ${e.sources ?? null}, ${!previous.has(e.ticker)}
      )
    `;
  }

  return NextResponse.json({
    ok: true,
    weekStart,
    runDate: now.toISOString().slice(0, 10),
    tickers: top50.length,
    newTickers,
  });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
