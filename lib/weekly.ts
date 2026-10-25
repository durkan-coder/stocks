// Stage 1: weekly catalyst scan -> top 50 shortlist.
// This is what makes the free-tier design work: instead of analysing
// 500 tickers every 15 minutes, we pick ~50 once a week that have a
// reason to move, then the 15-minute scan only watches those 50.
// Everything else is checked on demand (see /api/scan?ticker=XYZ).

export type CatalystType =
  | "earnings"
  | "guidance"
  | "macro"
  | "geopolitical"
  | "sector"
  | "regulatory"
  | "product";

export interface CatalystEvent {
  ticker: string; // or "SECTOR:energy", "MACRO:oil", etc. for broad events
  company?: string;
  type: CatalystType;
  eventDate?: string; // ISO date within the coming week
  detail: string;
  // 0-100: how directly this event could move the ticker 5%+ this week.
  // Earnings with a wide options-implied move, or a direct war/oil
  // exposure, scores higher than a vague sector headline.
  impact: number;
  // 0-100: how certain / confirmed the event is (scheduled earnings = high,
  // rumour / developing war news = lower, and must be labelled as such).
  certainty: number;
  sources?: string;
}

export function weeklyScore(e: CatalystEvent): number {
  // Impact matters more than certainty, but an unconfirmed rumour
  // should not top a confirmed earnings report.
  return Math.round((e.impact * 0.65 + e.certainty * 0.35) * 10) / 10;
}

export function selectTop50(events: CatalystEvent[]): Array<CatalystEvent & { score: number }> {
  // Collapse multiple events for the same ticker into its strongest one,
  // so one ticker with three headlines does not take three shortlist slots.
  const best = new Map<string, CatalystEvent & { score: number }>();
  for (const e of events) {
    const score = weeklyScore(e);
    const prev = best.get(e.ticker);
    if (!prev || score > prev.score) {
      best.set(e.ticker, { ...e, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 50);
}

// Catalyst buckets the weekly scan must check, in order:
// 1. Earnings / results due this week (company calendar, guidance updates)
// 2. Macro: CPI, jobs, Fed decisions / speeches, rates — moves whole sectors
// 3. Geopolitical / international: wars, sanctions, tariffs, oil & defence
//    exposure — map to tickers by revenue / supply-chain exposure, not by vibe
// 4. Sector: commodity moves, chip / AI news, healthcare approvals, bank stress
// 5. Company-specific: product launches, contracts, lawsuits, management change
export const WEEKLY_CATALYST_BUCKETS: CatalystType[] = [
  "earnings",
  "guidance",
  "macro",
  "geopolitical",
  "sector",
  "regulatory",
  "product",
];
