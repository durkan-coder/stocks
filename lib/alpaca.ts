// Alpaca PAPER trading only — never live.
// Credentials come from Vercel env vars already in the stocks project:
//   ALPACA_PAPER_KEY, ALPACA_PAPER_SECRET, ALPACA_PAPER_URL
// Values are never logged, never returned to the client, and never
// pasted in chat. This module refuses to run if the base URL does not
// look like Alpaca's paper endpoint.

export const TRADE_NOTIONAL_USD = 100;
export const TAKE_PROFIT_PCT = 0.03; // sell above +3% from entry (relaxed 2026-10-31, was +5%)
export const STOP_LOSS_PCT = -0.02; // sell below -2% from entry (relaxed 2026-10-31, was -3%)

function alpacaConfig() {
  const base = process.env.ALPACA_PAPER_URL ?? "https://paper-api.alpaca.markets";
  const key = process.env.ALPACA_PAPER_KEY;
  const secret = process.env.ALPACA_PAPER_SECRET;
  if (!key || !secret) throw new Error("Alpaca paper credentials are not configured");
  if (!base.includes("paper-api.alpaca.markets")) {
    throw new Error("Refusing to trade: ALPACA_PAPER_URL is not the paper endpoint");
  }
  return { base: base.replace(/\/$/, ""), key, secret };
}

async function alpaca(path: string, init: RequestInit = {}) {
  const { base, key, secret } = alpacaConfig();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Alpaca ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_plpc: string; // e.g. "0.032" = +3.2%
  market_value: string;
}

export async function getPositions(): Promise<AlpacaPosition[]> {
  return alpaca("/v2/positions");
}

export async function getAccount() {
  return alpaca("/v2/account");
}

export async function placeNotionalBuy(symbol: string, notional = TRADE_NOTIONAL_USD) {
  if (notional !== TRADE_NOTIONAL_USD) {
    throw new Error("Order size is fixed at $100 per stock by design");
  }
  return alpaca("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      notional: String(notional),
      side: "buy",
      type: "market",
      time_in_force: "day",
    }),
  });
}

// Tax-park buy: same idea as a stock buy (notional, fractional),
// but the amount is the tax slice from a sale, not the fixed $100
// — so it deliberately does NOT go through the $100 guard above.
// Minimum $1 (Alpaca's fractional minimum); smaller slices stay
// as "awaiting parking" until they add up to $1.
//
// Order type matters here (Alpaca docs, "Placing Orders"):
//
//   "Only limit orders with time_in_force set to day or gtc are
//   accepted as extended hours eligible. Any other type of orders
//   will be rejected" — so a MARKET order with extended_hours is
//   rejected after hours, not filled. The first Park tap (2:37pm
//   PT = 5:37pm ET) was a plain market order, which Alpaca
//   accepted and queued for the next session instead.
//
// So park buys are LIMIT orders: limit = last trade price + $0.05
// (SGOV barely moves, so that fills immediately in regular hours
// and after hours alike), day TIF, extended_hours eligible. If no
// quote is available, fall back to a plain market order (no
// extended_hours): it fills in regular hours and queues for the
// next session after hours — safe, and repairParkedEntries()
// cleans up if it never fills.
export const TAX_PARK_MIN_NOTIONAL_USD = 1;
export async function placeParkBuy(symbol: string, notional: number) {
  if (!Number.isFinite(notional) || notional < TAX_PARK_MIN_NOTIONAL_USD) {
    throw new Error("Park buy needs at least $1");
  }
  const last = await getLatestTradePrice(symbol);
  if (last !== null) {
    const limit = Math.ceil((last + 0.05) * 100) / 100;
    return alpaca("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol,
        notional: String(notional.toFixed(2)),
        side: "buy",
        type: "limit",
        limit_price: String(limit.toFixed(2)),
        time_in_force: "day",
        extended_hours: true,
      }),
    });
  }
  return alpaca("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      notional: String(notional.toFixed(2)),
      side: "buy",
      type: "market",
      time_in_force: "day",
    }),
  });
}

export async function getOrder(orderId: string) {
  return alpaca(`/v2/orders/${orderId}`);
}

// Latest trade price from Alpaca's data API (same paper keys).
// Used only as a fallback entry price for a park buy that has not
// filled yet — SGOV's price barely moves, so the quote is within
// pennies of the eventual fill.
export async function getLatestTradePrice(symbol: string): Promise<number | null> {
  const { base, key, secret } = (() => {
    const b = process.env.ALPACA_PAPER_URL ?? "https://paper-api.alpaca.markets";
    return { base: b.replace(/\/$/, ""), key: process.env.ALPACA_PAPER_KEY, secret: process.env.ALPACA_PAPER_SECRET };
  })();
  if (!key || !secret || !base.includes("paper-api.alpaca.markets")) return null;
  try {
    const res = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest`, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const p = Number(j?.trade?.p);
    return Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

export async function closePosition(symbol: string) {
  // Closes the whole position at market, whatever its size.
  return alpaca(`/v2/positions/${symbol}`, { method: "DELETE" });
}

export function shouldSell(plpc: number): "take_profit" | "stop_loss" | null {
  if (plpc >= TAKE_PROFIT_PCT) return "take_profit";
  if (plpc <= STOP_LOSS_PCT) return "stop_loss";
  return null;
}
