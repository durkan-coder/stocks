// Scoring + market-status helpers, shared by /api/scan.
// Mirrors plan.md and runner.py: technical 30 / catalyst 30 / sentiment 20
// / volume 10 / sector 10. Horizon: 5%+ within 1 week.

export type MarketStatus = "open" | "pre_market" | "after_hours" | "closed";

export function marketStatus(now = new Date()): MarketStatus {
  // America/New_York via Intl, so the server timezone does not matter.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = get("weekday");
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (weekday === "Sat" || weekday === "Sun") return "closed";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "open";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre_market";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "after_hours";
  return "closed";
}

export interface ScoredCandidate {
  ticker: string;
  company?: string;
  price?: number;
  change1dPct?: number;
  change5dPct?: number;
  volumeRatio?: number;
  score: number;
  catalyst?: string;
  sentiment?: string;
  reasoning: string;
  sources?: string;
  confidence: "watch" | "notable" | "strong";
}

export function scoreCandidate(input: {
  technical: number;
  catalyst: number;
  sentiment: number;
  volume: number;
  sector: number;
}): number {
  let score =
    input.technical * 0.3 +
    input.catalyst * 0.3 +
    input.sentiment * 0.2 +
    input.volume * 0.1 +
    input.sector * 0.1;
  // No catalyst, no board: cap pure price moves.
  if (input.catalyst === 0) score = Math.min(score, 49);
  return Math.round(score * 10) / 10;
}

export function confidenceFor(score: number): ScoredCandidate["confidence"] {
  if (score >= 75) return "strong";
  if (score >= 60) return "notable";
  return "watch";
}
