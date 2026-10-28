import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";

// Ask about the scanner's decisions — explanation only, never a trade.
// Public endpoint on purpose: the context it uses (latest leaderboard,
// shortlist, paper trades, recent scans) is already public on the
// dashboard homepage, so no private data is exposed. It cannot place
// trades, change jobs, or invent picks: the LLM is grounded in the
// Neon rows below, and is instructed to say when a ticker is not in
// the current board/shortlist instead of guessing.
//
// OpenRouter free model (same env as sentiment: OPENROUTER_API_KEY,
// OPENROUTER_MODEL default "openrouter/free"). Guardrails: question
// capped at 500 chars, answer capped at ~700 tokens, 30s timeout, no
// retries on 429/failure — a failed call returns a plain error, never
// a fabricated answer. Screening only, not financial advice.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const question = String((body as { question?: unknown }).question ?? "").trim();
  if (!question || question.length > 500) {
    return NextResponse.json({ error: "question must be 1-500 characters" }, { status: 400 });
  }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "chat is not configured (no OpenRouter key)" }, { status: 503 });
  }

  // Grounding context from Neon — same data the dashboard shows.
  let context = "";
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const scans: any[] = await sql`SELECT id, scanned_at, market_status FROM scans ORDER BY id DESC LIMIT 1`;
    const board: any[] = scans.length
      ? await sql`
          SELECT rank, ticker, company, price, change_1d_pct, score, catalyst, sentiment, reasoning, confidence
          FROM leaderboard WHERE scan_id = ${scans[0].id} ORDER BY rank ASC LIMIT 20
        `
      : [];
    const shortlist: any[] = await sql`
      SELECT ticker, company, catalyst_type, event_date, event_detail, score
      FROM weekly_shortlist
      WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
      ORDER BY score DESC LIMIT 50
    `;
    const trades: any[] = await sql`
      SELECT ticker, leaderboard_rank, entry_price, notional_usd, status, exit_price, pnl_pct, opened_at, closed_at
      FROM paper_trades ORDER BY opened_at DESC LIMIT 20
    `;
    const lines: string[] = [];
    if (scans.length) lines.push(`Latest scan: ${scans[0].scanned_at} (${scans[0].market_status}).`);
    if (board.length) {
      lines.push("Leaderboard (latest scan, rank order):");
      for (const r of board) {
        lines.push(`- #${r.rank} ${r.ticker} (${r.company ?? ""}): score ${r.score} (${r.confidence}), price ${r.price ?? "?"}, 1d ${r.change_1d_pct ?? "?"}%, catalyst: ${r.catalyst ?? "?"}, sentiment: ${r.sentiment ?? "?"}, reasoning: ${r.reasoning ?? ""}`);
      }
    } else {
      lines.push("Leaderboard: empty in the latest scan.");
    }
    if (shortlist.length) {
      lines.push("Daily shortlist (catalysts, score order):");
      for (const s of shortlist) {
        lines.push(`- ${s.ticker}: ${s.catalyst_type}, event ${s.event_date ?? "?"}, score ${s.score}, detail: ${s.event_detail ?? ""}`);
      }
    }
    if (trades.length) {
      lines.push("Paper trades (recent, $100 each, paper only; sell at +5% / -3% via /api/trade/check; daily buy is one unique leaderboard stock per day):");
      for (const t of trades) {
        lines.push(`- ${t.ticker}: rank ${t.leaderboard_rank ?? "?"}, entry ${t.entry_price ?? "?"}, status ${t.status}, exit ${t.exit_price ?? "?"}, pnl ${t.pnl_pct ?? "?"}`);
      }
    } else {
      lines.push("Paper trades: none yet.");
    }
    context = lines.join("\n");
  } catch {
    context = "Live scanner data could not be loaded for this question.";
  }

  const model = process.env.OPENROUTER_MODEL ?? "openrouter/free";
  const prompt = [
    "You explain decisions made by an SPY / S&P 500 stock scanner. Use ONLY the scanner data below.",
    "Do not invent prices, scores, catalysts, earnings dates, or trades that are not in the data.",
    "If the user asks about a ticker that is not in the leaderboard or shortlist below, say so plainly.",
    "Explain in plain language: why a ticker ranks where it does, what its catalyst is, why a trade was bought or skipped, or why a position was closed or is still open.",
    "Do not recommend buying or selling, do not make a new pick, and do not present a score as a guarantee of a 5% rise. End with a short note that this is screening only, not financial advice.",
    "",
    "SCANNER DATA:",
    context,
    "",
    `USER QUESTION: ${question}`,
  ].join("\n");

  let res: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://stocks-ronik7.vercel.app",
          "X-Title": "SPY Scanner",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 700,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return NextResponse.json({ error: "chat request failed (timeout or network error)" }, { status: 502 });
  }
  if (!res.ok) {
    return NextResponse.json({ error: `chat provider returned ${res.status}` }, { status: 502 });
  }
  let answer = "";
  try {
    const json = await res.json();
    answer = String(json?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    answer = "";
  }
  if (!answer) {
    return NextResponse.json({ error: "chat provider returned an empty answer" }, { status: 502 });
  }
  return NextResponse.json({ ok: true, answer, model });
}
