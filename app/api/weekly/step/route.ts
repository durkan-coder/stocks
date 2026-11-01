import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import {
  addDays,
  getCompanyNews,
  getEarningsHistory,
  getMacroEvents,
  getMonthlyCandleData,
  isoDate,
  mapLimit,
  type MonthlyCandleData,
} from "@/lib/feed";
import { getUniverse } from "@/lib/universe";
import { analyzeSentimentBatch, screenSetups, sentimentToScore100 } from "@/lib/openrouter";

// STAGGERED WEEKLY — STAGE 2+ (step), called repeatedly by
// cron-job.org (every 2 minutes, same CRON_SECRET header as the
// start job). Each call does exactly ONE small unit of work for
// today's run, then advances the pointer in Neon:
//
//   enrich slice 0..N  (10 tickers: monthly candles, earnings
//                       history, sector-relative, score modifier)
//   sentiment slice 0..N (10 tickers: one OpenRouter batch call,
//                       sentiment appended to reasoning)
//   finalize           (macro events + LLM screen over top 15)
//
// Rules that make this safe under cron-job.org's 30s timeout:
// - The shortlist already exists (written by /api/weekly start),
//   so a timed-out step loses nothing — the pointer simply does
//   not advance, and the next call retries the same slice.
// - Every row update is idempotent: enrich recomputes
//   score = base_score + modifier (never modifier-on-modifier),
//   and reasoning is rebuilt from event_detail, never appended
//   blindly twice (sentiment is only added if not already present).
// - After finalize, or with no start row today, the route returns
//   immediately (one DB query) — so running it all day is cheap
//   and harmless. The 15-minute scan and daily buy use whatever
//   enrichment has landed so far; they never wait for finalize.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SLICE = 10;

const sectorEtfBySector: Record<string, string> = {
  "Information Technology": "XLK", Technology: "XLK",
  Financials: "XLF", "Financial Services": "XLF",
  "Communication Services": "XLC",
  "Health Care": "XLV", Healthcare: "XLV",
  "Consumer Discretionary": "XLY",
  Industrials: "XLI",
  "Consumer Staples": "XLP",
  Energy: "XLE",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  Materials: "XLB",
};

type ShortlistRow = {
  id: number;
  ticker: string;
  company: string | null;
  catalyst_type: string;
  event_date: string | null;
  event_detail: string;
  reasoning: string;
  score: number;
  base_score: number | null;
  rsi14: number | null;
  month_pct: number | null;
  volume_ratio: number | null;
  avg_abs_daily_pct: number | null;
  change_5d_pct: number | null;
  sector_rel_pct: number | null;
};

function clamp100(v: number) {
  return Math.max(0, Math.min(100, v));
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const sql = neon(process.env.DATABASE_URL!);
  const now = new Date();

  let progress: Array<{ stage: string; slice: number; finished: boolean }> = [];
  try {
    progress = await sql`
      SELECT stage, slice, finished FROM weekly_progress
      WHERE run_date = CURRENT_DATE
    ` as unknown as typeof progress;
  } catch {
    return NextResponse.json({ ok: true, status: "idle", reason: "no weekly_progress table yet" });
  }
  if (progress.length === 0) {
    return NextResponse.json({ ok: true, status: "idle", reason: "no start run today" });
  }
  const p = progress[0];
  if (p.finished) {
    return NextResponse.json({ ok: true, status: "done", reason: "today's weekly run is fully enriched" });
  }

  let rows: ShortlistRow[] = [];
  try {
    rows = await sql`
      SELECT id, ticker, company, catalyst_type, event_date, event_detail,
             reasoning, score, base_score, rsi14, month_pct, volume_ratio,
             avg_abs_daily_pct, change_5d_pct, sector_rel_pct
      FROM weekly_shortlist
      WHERE DATE(created_at) = CURRENT_DATE
      ORDER BY id ASC
    ` as unknown as ShortlistRow[];
  } catch {
    return NextResponse.json({ ok: true, status: "idle", reason: "no shortlist rows today" });
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, status: "idle", reason: "no shortlist rows today" });
  }

  const totalSlices = Math.ceil(rows.length / SLICE);

  async function advance(nextStage: string, nextSlice: number, finished: boolean) {
    await sql`
      UPDATE weekly_progress
      SET stage = ${nextStage}, slice = ${nextSlice}, finished = ${finished},
          updated_at = NOW()
      WHERE run_date = CURRENT_DATE
    `;
  }

  // ---- enrich slice ----
  if (p.stage === "enrich") {
    const sliceRows = rows.slice(p.slice * SLICE, p.slice * SLICE + SLICE);
    // Sector ETF month % (11 calls, once per enrich step).
    const sectorMonthByEtf = new Map<string, number>();
    try {
      const etfPairs = await mapLimit([...new Set(Object.values(sectorEtfBySector))], 4, async (etf) => ({
        etf,
        data: await getMonthlyCandleData(etf),
      }));
      for (const pair of etfPairs) {
        if (pair.data) sectorMonthByEtf.set(pair.etf, pair.data.monthPct);
      }
    } catch {
      // ETF failure -> sector-relative is null for this slice.
    }
    let sectorByTicker = new Map<string, string>();
    try {
      const universe = await getUniverse();
      sectorByTicker = new Map(universe.list.map((c) => [c.ticker, c.sector ?? ""]));
    } catch {
      sectorByTicker = new Map();
    }

    for (const row of sliceRows) {
      let m: MonthlyCandleData | null = null;
      try {
        m = await getMonthlyCandleData(row.ticker);
      } catch {
        m = null;
      }
      let hist: Awaited<ReturnType<typeof getEarningsHistory>> = null;
      try {
        hist = row.catalyst_type === "earnings" ? await getEarningsHistory(row.ticker) : null;
      } catch {
        hist = null;
      }
      const sector = sectorByTicker.get(row.ticker) ?? "";
      const etf = sectorEtfBySector[sector];
      const etfMonth = etf ? sectorMonthByEtf.get(etf) : undefined;
      const sectorRel = m && etfMonth !== undefined ? m.monthPct - etfMonth : null;

      const base = row.base_score !== null && row.base_score !== undefined ? Number(row.base_score) : Number(row.score);
      let newScore = base;
      if (hist && hist.total >= 3) {
        if (hist.beats >= 3) newScore = clamp100(base + 3);
        else if (hist.beats <= 1) newScore = clamp100(base - 3);
      }
      const reasoning = [
        row.event_detail,
        m?.summary ?? null,
        hist?.summary ?? null,
        sectorRel !== null ? `vs sector: ${sectorRel >= 0 ? "+" : ""}${sectorRel.toFixed(1)}% this month.` : null,
        // Preserve an already-written sentiment line on retry.
        row.reasoning.includes("Sentiment (LLM):")
          ? row.reasoning.slice(row.reasoning.indexOf("Sentiment (LLM):"))
          : null,
      ]
        .filter((x): x is string => x !== null)
        .join(" ");

      await sql`
        UPDATE weekly_shortlist SET
          reasoning = ${reasoning}, score = ${newScore},
          rsi14 = ${m?.rsi14 ?? null}, month_pct = ${m?.monthPct ?? null},
          volume_ratio = ${m?.volumeRatio ?? null},
          avg_abs_daily_pct = ${m?.avgAbsDailyPct ?? null},
          change_5d_pct = ${m?.change5dPct ?? null},
          sector_rel_pct = ${sectorRel},
          earnings_beats = ${hist?.beats ?? null}, earnings_total = ${hist?.total ?? null},
          avg_surprise_pct = ${hist?.avgSurprisePct ?? null}
        WHERE id = ${row.id}
      `;
    }

    const nextSlice = p.slice + 1;
    if (nextSlice >= totalSlices) await advance("sentiment", 0, false);
    else await advance("enrich", nextSlice, false);
    return NextResponse.json({
      ok: true, status: "enriched", stage: "enrich",
      slice: p.slice, totalSlices, tickers: sliceRows.map((r) => r.ticker),
      nextStage: nextSlice >= totalSlices ? "sentiment" : "enrich",
    });
  }

  // ---- sentiment slice ----
  if (p.stage === "sentiment") {
    const sliceRows = rows.slice(p.slice * SLICE, p.slice * SLICE + SLICE);
    const newsFrom = isoDate(addDays(now, -3));
    const from = isoDate(now);
    const newsPairs = await mapLimit(sliceRows, 5, async (r) => ({
      ticker: r.ticker,
      news: await getCompanyNews(r.ticker, newsFrom, from),
    }));
    const batch = newsPairs.map((pair) => ({
      ticker: pair.ticker,
      headlines: pair.news.slice(0, 3).map((n) => n.headline),
    }));
    const results = await analyzeSentimentBatch(batch);
    for (const row of sliceRows) {
      const s = results.get(row.ticker);
      if (!s) continue;
      if (row.reasoning.includes("Sentiment (LLM):")) continue;
      const score100 = sentimentToScore100(s.score);
      const line = `Sentiment (LLM): ${s.label}, ${((score100 - 50) / 50).toFixed(2)} — ${s.reason}`;
      await sql`
        UPDATE weekly_shortlist SET reasoning = ${row.reasoning + " " + line}
        WHERE id = ${row.id}
      `;
    }
    const nextSlice = p.slice + 1;
    if (nextSlice >= totalSlices) await advance("finalize", 0, false);
    else await advance("sentiment", nextSlice, false);
    return NextResponse.json({
      ok: true, status: "enriched", stage: "sentiment",
      slice: p.slice, totalSlices, tickers: sliceRows.map((r) => r.ticker),
      sentimentTickers: results.size,
      nextStage: nextSlice >= totalSlices ? "finalize" : "sentiment",
    });
  }

  // ---- finalize: macro + LLM screen ----
  const from = isoDate(now);
  const to = isoDate(addDays(now, 7));
  let macroEvents: Array<{ date: string; event: string }> = [];
  try {
    macroEvents = await getMacroEvents(from, to);
  } catch {
    macroEvents = [];
  }
  let llmScreen: Array<{ ticker: string; reason: string }> = [];
  try {
    const candidates = rows.slice(0, 15).map((e) => {
      const reasoning = e.reasoning;
      const sentimentMatch = reasoning.match(/Sentiment \(LLM\): (\w+)/);
      return {
        ticker: e.ticker,
        catalystType: e.catalyst_type,
        eventDate: e.event_date ?? undefined,
        eventDetail: e.event_detail,
        shortlistScore: Number(e.score),
        rsi14: e.rsi14 !== null ? Number(e.rsi14) : null,
        monthPct: e.month_pct !== null ? Number(e.month_pct) : null,
        volumeRatio: e.volume_ratio !== null ? Number(e.volume_ratio) : null,
        avgAbsDailyPct: e.avg_abs_daily_pct !== null ? Number(e.avg_abs_daily_pct) : null,
        breakout: false,
        sentimentLabel: sentimentMatch ? sentimentMatch[1] : "neutral",
        headlines: [] as string[],
      };
    });
    llmScreen = await screenSetups(candidates);
  } catch {
    llmScreen = [];
  }
  try {
    await sql`CREATE TABLE IF NOT EXISTS macro_events (
      id SERIAL PRIMARY KEY,
      event_date DATE NOT NULL,
      event TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
    await sql`DELETE FROM macro_events WHERE DATE(created_at) = CURRENT_DATE`;
    for (const ev of macroEvents) {
      await sql`INSERT INTO macro_events (event_date, event) VALUES (${ev.date}, ${ev.event})`;
    }
  } catch {
    // Macro storage failure must not fail finalize.
  }
  try {
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
    await sql`DELETE FROM llm_screen WHERE DATE(created_at) = CURRENT_DATE`;
    for (let i = 0; i < llmScreen.length; i++) {
      const pick = llmScreen[i];
      const e = rows.find((x) => x.ticker === pick.ticker);
      await sql`
        INSERT INTO llm_screen
          (screen_date, rank, ticker, reason, catalyst_type, event_date, rsi14, month_pct, volume_ratio)
        VALUES (
          ${now.toISOString().slice(0, 10)}, ${i + 1}, ${pick.ticker}, ${pick.reason},
          ${e?.catalyst_type ?? null}, ${e?.event_date ?? null},
          ${e?.rsi14 ?? null}, ${e?.month_pct ?? null}, ${e?.volume_ratio ?? null}
        )
      `;
    }
  } catch {
    llmScreen = [];
  }
  await advance("finalize", 0, true);
  return NextResponse.json({
    ok: true, status: "done", stage: "finalize",
    macroEvents: macroEvents.length, llmScreenTickers: llmScreen.length, llmScreen,
  });
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
