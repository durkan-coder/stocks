// Alpaca PAPER trading only — never live.
// Credentials come from Vercel env vars already in the stocks project:
//   ALPACA_PAPER_KEY, ALPACA_PAPER_SECRET, ALPACA_PAPER_URL
// Values are never logged, never returned to the client, and never
// pasted in chat. This module refuses to run if the base URL does not
// look like Alpaca's paper endpoint.

export const TRADE_NOTIONAL_USD = 100;
export const TAKE_PROFIT_PCT = 0.05; // sell above +5% from entry
export const STOP_LOSS_PCT = -0.03; // sell below -3% from entry

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
  unrealized_plpc: string; // e.g. "0.052" = +5.2%
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

export async function closePosition(symbol: string) {
  // Closes the whole position at market, whatever its size.
  return alpaca(`/v2/positions/${symbol}`, { method: "DELETE" });
}

export function shouldSell(plpc: number): "take_profit" | "stop_loss" | null {
  if (plpc >= TAKE_PROFIT_PCT) return "take_profit";
  if (plpc <= STOP_LOSS_PCT) return "stop_loss";
  return null;
}
