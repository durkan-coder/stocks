// Tax reserve logic — estimate only, NOT tax advice.
// The user's choice (2026-11-09): calculate capital gains at the
// highest federal ceiling and park the tax part in a money market
// fund (capital preserved, not reinvested) so it is there at tax
// time; the rest is available to reinvest.
//
// Rates (2026 federal, verified against IRS Rev. Proc. 2025-32):
//  - Short-term (held <= 1 year): top ordinary rate 37% + 3.8%
//    Net Investment Income Tax = 40.8%. Every scanner trade is
//    short-term by design (7-day horizon), so this is the rate
//    that actually applies to this app's sales.
//  - Long-term (held > 1 year): top 20% + 3.8% NIIT = 23.8%.
//    Included for completeness if a position is ever held long.
//  - No state tax is included: the rate is federal only. Add a
//    state rate here if the user asks for one (e.g. California
//    taxes all gains at a flat 13.3%, with no long-term break).
//  - Tax applies ONLY to realized gains (a sale). Unrealised
//    gains are shown as a "sell now" preview, never taxed.
//  - Losses are netted against gains first (short-term losses
//    offset short-term gains, long-term losses offset long-term
//    gains, and a net loss in one bucket offsets a net gain in
//    the other), and tax is charged on what is left. If the net
//    is a loss, tax owed is $0.
//  - Wash sales are NOT tracked: rebuying the same ticker within
//    30 days of a loss sale can defer that loss. Flagged here as
//    a known limitation, not modelled.

export const SHORT_TERM_TAX_RATE = 0.408; // 37% + 3.8% NIIT
export const LONG_TERM_TAX_RATE = 0.238; // 20% + 3.8% NIIT
export const LONG_TERM_MIN_DAYS = 365;

export interface TaxTradeLike {
  ticker: string;
  entry_price: number | string | null;
  exit_price: number | string | null;
  pnl_pct: number | string | null; // stored as a FRACTION (e.g. 0.032)
  notional_usd: number | string | null;
  opened_at: string | Date | null;
  closed_at: string | Date | null;
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Realized gain in dollars. Preferred source is the stored pnl
// fraction x notional (what the sell/check routes record); falls
// back to (exit - entry) / entry x notional.
export function tradeGainUsd(t: TaxTradeLike): number | null {
  const notional = num(t.notional_usd) ?? 100;
  const pnl = num(t.pnl_pct);
  if (pnl !== null) return pnl * notional;
  const entry = num(t.entry_price);
  const exit = num(t.exit_price);
  if (entry === null || entry === 0 || exit === null) return null;
  return ((exit - entry) / entry) * notional;
}

// Sale proceeds in dollars: what the sale actually returned.
export function tradeProceedsUsd(t: TaxTradeLike): number | null {
  const gain = tradeGainUsd(t);
  if (gain === null) return null;
  const notional = num(t.notional_usd) ?? 100;
  return notional + gain;
}

export function holdingDays(t: TaxTradeLike): number | null {
  if (!t.opened_at || !t.closed_at) return null;
  const ms = new Date(t.closed_at).getTime() - new Date(t.opened_at).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 86400000);
}

export function isLongTerm(t: TaxTradeLike): boolean {
  const d = holdingDays(t);
  return d !== null && d > LONG_TERM_MIN_DAYS;
}

export function taxRateFor(t: TaxTradeLike): number {
  return isLongTerm(t) ? LONG_TERM_TAX_RATE : SHORT_TERM_TAX_RATE;
}

export interface TaxTradeRow {
  ticker: string;
  gainUsd: number | null;
  proceedsUsd: number | null;
  longTerm: boolean;
  rate: number;
  // Gross tax slice for this trade alone (gain x rate, $0 on a
  // loss). The headline tax owed is NETTED (see below), so these
  // slices can sum above the headline when losses exist.
  taxSliceUsd: number | null;
  netUsd: number | null; // proceeds minus this trade's tax slice
}

export interface TaxSummary {
  tradeCount: number;
  stGains: number;
  stLosses: number; // negative number (or 0)
  ltGains: number;
  ltLosses: number; // negative number (or 0)
  stNet: number;
  ltNet: number;
  taxableSt: number; // >= 0, after cross-netting
  taxableLt: number; // >= 0, after cross-netting
  taxOwed: number; // netted estimate
  totalProceeds: number;
  taxReserve: number; // == taxOwed: parked in the money market fund
  reinvestable: number; // proceeds minus reserve
  trades: TaxTradeRow[];
}

export function computeTaxSummary(trades: TaxTradeLike[]): TaxSummary {
  const rows: TaxTradeRow[] = trades.map((t) => {
    const gain = tradeGainUsd(t);
    const proceeds = tradeProceedsUsd(t);
    const longTerm = isLongTerm(t);
    const rate = longTerm ? LONG_TERM_TAX_RATE : SHORT_TERM_TAX_RATE;
    const taxSlice = gain === null ? null : gain > 0 ? gain * rate : 0;
    return {
      ticker: t.ticker,
      gainUsd: gain,
      proceedsUsd: proceeds,
      longTerm,
      rate,
      taxSliceUsd: taxSlice,
      netUsd: proceeds === null || taxSlice === null ? null : proceeds - taxSlice,
    };
  });

  let stGains = 0;
  let stLosses = 0;
  let ltGains = 0;
  let ltLosses = 0;
  let totalProceeds = 0;
  for (const r of rows) {
    if (r.gainUsd === null) continue;
    if (r.longTerm) {
      if (r.gainUsd > 0) ltGains += r.gainUsd;
      else ltLosses += r.gainUsd;
    } else {
      if (r.gainUsd > 0) stGains += r.gainUsd;
      else stLosses += r.gainUsd;
    }
    if (r.proceedsUsd !== null) totalProceeds += r.proceedsUsd;
  }
  const stNet = stGains + stLosses;
  const ltNet = ltGains + ltLosses;

  // Cross-netting: a net loss in one bucket offsets a net gain
  // in the other, and the surviving gain keeps its own rate.
  let taxableSt = 0;
  let taxableLt = 0;
  if (stNet >= 0 && ltNet >= 0) {
    taxableSt = stNet;
    taxableLt = ltNet;
  } else if (stNet < 0 && ltNet >= 0) {
    taxableLt = Math.max(0, ltNet + stNet);
  } else if (ltNet < 0 && stNet >= 0) {
    taxableSt = Math.max(0, stNet + ltNet);
  }
  // Both negative: nothing taxable.
  const taxOwed = taxableSt * SHORT_TERM_TAX_RATE + taxableLt * LONG_TERM_TAX_RATE;

  return {
    tradeCount: rows.length,
    stGains,
    stLosses,
    ltGains,
    ltLosses,
    stNet,
    ltNet,
    taxableSt,
    taxableLt,
    taxOwed,
    totalProceeds,
    taxReserve: taxOwed,
    reinvestable: totalProceeds - taxOwed,
    trades: rows,
  };
}
