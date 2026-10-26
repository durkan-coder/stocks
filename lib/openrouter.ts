// LLM sentiment via OpenRouter, free tier.
// Cost guardrails — this is why the design is batched, not per-scan:
// - Free account: ~50 requests/day, 20/min. With a $10 lifetime credit
//   purchase (which Durkan made 2026-10-25) the free-model cap rises
//   to ~1,000/day. Still do NOT call this per ticker per 15-minute scan.
// - Intended use: once a day at the daily catalyst rebuild, in batches
//   of up to 10 tickers per request (50 tickers = ~5 requests/day), and
//   the resulting sentiment is reused by the 15-minute scans.
// - On any failure (no key, 429, bad JSON, timeout) return an empty
//   result — the caller falls back to rule-based sentiment and never
//   invents a score. No retries: failed calls still count to quota.
// Env: OPENROUTER_API_KEY (Vercel env var, never in code/chat),
//      OPENROUTER_MODEL (optional, default "openrouter/free").

export interface SentimentInput {
  ticker: string;
  headlines: string[];
}

export interface SentimentResult {
  ticker: string;
  // -1 (very negative) to +1 (very positive)
  score: number;
  label: "positive" | "neutral" | "negative";
  reason: string;
}

export function sentimentToScore100(score: number): number {
  return Math.round(((Math.max(-1, Math.min(1, score)) + 1) * 50) * 10) / 10;
}

function labelFor(score: number): SentimentResult["label"] {
  if (score >= 0.25) return "positive";
  if (score <= -0.25) return "negative";
  return "neutral";
}

export async function analyzeSentimentBatch(
  items: SentimentInput[],
): Promise<Map<string, SentimentResult>> {
  const empty = new Map<string, SentimentResult>();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || items.length === 0) return empty;
  const model = process.env.OPENROUTER_MODEL ?? "openrouter/free";
  const batch = items.slice(0, 10);

  const prompt = [
    "You are a stock-news sentiment classifier. For each ticker below,",
    "classify sentiment of its recent headlines for a 1-week horizon.",
    "Return ONLY a JSON array, no other text, with one object per ticker:",
    '[{"ticker":"XYZ","score":0.6,"reason":"one short sentence"}].',
    "score is -1 to 1. Do not invent news; if headlines are weak or",
    "mixed, use a score near 0.",
    "",
    ...batch.map(
      (b) => `${b.ticker}: ${b.headlines.slice(0, 5).join(" | ") || "no headlines"}`,
    ),
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
          max_tokens: 800,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return empty;
  }
  if (!res.ok) return empty; // includes 429 — do not retry, quota is precious

  let text = "";
  try {
    const json = await res.json();
    text = json?.choices?.[0]?.message?.content ?? "";
  } catch {
    return empty;
  }
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return empty;
  }
  if (!Array.isArray(parsed)) return empty;
  const out = new Map<string, SentimentResult>();
  for (const row of parsed as Array<Record<string, unknown>>) {
    if (typeof row.ticker !== "string" || typeof row.score !== "number") continue;
    const score = Math.max(-1, Math.min(1, row.score));
    out.set(row.ticker.toUpperCase(), {
      ticker: row.ticker.toUpperCase(),
      score,
      label: labelFor(score),
      reason: typeof row.reason === "string" ? row.reason.slice(0, 200) : "",
    });
  }
  return out;
}
