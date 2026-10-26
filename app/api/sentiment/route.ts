import { NextRequest, NextResponse } from "next/server";
import { analyzeSentimentBatch, sentimentToScore100 } from "@/lib/openrouter";

// Test / manual endpoint for the OpenRouter sentiment module.
// CRON_SECRET-protected, same as scan/weekly. POST JSON:
//   {"items":[{"ticker":"NVDA","headlines":["...","..."]}]}
 // Up to 10 tickers per call (free-tier guardrail). Returns the LLM
// sentiment per ticker, or an empty result when no key is configured
// or OpenRouter fails — in which case the scan falls back to
// rule-based sentiment, it does not invent a score.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
    return NextResponse.json(
      { error: "items must be an array of 1-10 {ticker, headlines[]}" },
      { status: 400 },
    );
  }
  const cleaned = items.map((it) => {
    const row = it as { ticker?: unknown; headlines?: unknown };
    return {
      ticker: String(row.ticker ?? "").toUpperCase(),
      headlines: Array.isArray(row.headlines)
        ? row.headlines.filter((h): h is string => typeof h === "string")
        : [],
    };
  });
  const results = await analyzeSentimentBatch(cleaned);
  return NextResponse.json({
    ok: true,
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    model: process.env.OPENROUTER_MODEL ?? "openrouter/free",
    results: [...results.values()].map((r) => ({
      ...r,
      score100: sentimentToScore100(r.score),
    })),
  });
}
