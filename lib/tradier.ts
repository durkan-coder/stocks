// Tradier sandbox expected move — free, delayed data, for the daily
// screen only (never per 15-minute scan tick).
//
// Env (names only, values never logged or pasted in chat):
//   TRADIER_TOKEN — sandbox token from developer.tradier.com
//   TRADIER_API_URL — optional, default https://sandbox.tradier.com/v1
//     (sandbox only, by design: this build was approved for sandbox
//     first, not live Tradier data)
//
// Method, per ticker:
//   1. GET /markets/options/expirations?symbol=XYZ
//   2. Pick the first expiry at least 3 days out and at most 14 days
//      out (the 1-week horizon); if none, the first expiry after today.
//   3. GET /markets/options/chains?symbol=XYZ&expiration=DATE&greeks=true
//   4. At the strike closest to the spot price (prior close, supplied
//      by the caller from monthly candles — no extra quote call),
//      expected move % = (ATM call mid + ATM put mid) / spot * 100,
//      where mid = (bid + ask) / 2 when both are positive, else last.
//   5. IV, when the chain's Greeks provide it, is the average of the
//      ATM call and put mid_iv values; otherwise null.
//
// Fail-soft everywhere: no token, no expirations, no ATM pair, or any
// fetch/timeout failure returns null — the caller writes no expected
// move line, never a fabricated one. Sandbox data is delayed 15
// minutes and the spot is the prior close, so this is a daily
// screening input, not a live quote. Reasoning-only in v1: it is
// stored in weekly_shortlist.reasoning and passed to the LLM screen,
// but it does NOT change leaderboard or shortlist scores.
export interface TradierExpectedMove {
  ticker: string;
  expiry: string;
  spot: number;
  expectedMovePct: number;
  iv: number | null;
}

async function tradierGet(path: string, token: string, base: string): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function asList(v: unknown): Array<Record<string, any>> {
  if (Array.isArray(v)) return v as Array<Record<string, any>>;
  if (v !== null && typeof v === "object") return [v as Record<string, any>];
  return [];
}

export async function getTradierExpectedMove(
  symbol: string,
  spot: number,
): Promise<TradierExpectedMove | null> {
  const token = process.env.TRADIER_TOKEN;
  if (!token || !spot || spot <= 0) return null;
  const base = (process.env.TRADIER_API_URL ?? "https://sandbox.tradier.com/v1").replace(/\/$/, "");
  const expData = await tradierGet(`/markets/options/expirations?symbol=${encodeURIComponent(symbol)}`, token, base);
  const expObj = expData !== null && typeof expData === "object" ? (expData as any).expirations : null;
  const datesRaw = expObj?.date;
  const dates: string[] = Array.isArray(datesRaw) ? datesRaw.filter((d) => typeof d === "string") : typeof datesRaw === "string" ? [datesRaw] : [];
  if (dates.length === 0) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const parsed = dates
    .map((d) => ({ date: d, ms: Date.parse(`${d}T00:00:00Z`) }))
    .filter((d) => Number.isFinite(d.ms) && d.ms > today.getTime())
    .sort((a, b) => a.ms - b.ms);
  if (parsed.length === 0) return null;
  const inWindow = parsed.filter((d) => d.ms - today.getTime() >= 3 * 24 * 3600 && d.ms - today.getTime() <= 14 * 24 * 3600);
  const chosen = inWindow[0] ?? parsed[0];
  const chainData = await tradierGet(
    `/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(chosen.date)}&greeks=true`,
    token,
    base,
  );
  const chainObj = chainData !== null && typeof chainData === "object" ? (chainData as any).options : null;
  const contracts = asList(chainObj?.option);
  if (contracts.length === 0) return null;
  const numField = (o: Record<string, any>, k: string): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const midPrice = (o: Record<string, any>): number | null => {
    const bid = numField(o, "bid");
    const ask = numField(o, "ask");
    if (bid !== null && ask !== null && bid > 0 && ask > 0) return (bid + ask) / 2;
    const last = numField(o, "last");
    return last !== null && last > 0 ? last : null;
  };
  // Strike closest to spot, separately for calls and puts, so the pair
  // is a true ATM straddle at one strike when possible.
  let bestCall: Record<string, any> | null = null;
  let bestPut: Record<string, any> | null = null;
  for (const c of contracts) {
    const strike = numField(c, "strike");
    if (strike === null) continue;
    const dist = Math.abs(strike - spot);
    if (c.option_type === "call" && (bestCall === null || dist < Math.abs(numField(bestCall, "strike")! - spot))) bestCall = c;
    if (c.option_type === "put" && (bestPut === null || dist < Math.abs(numField(bestPut, "strike")! - spot))) bestPut = c;
  }
  if (!bestCall || !bestPut) return null;
  const callStrike = numField(bestCall, "strike")!;
  const putStrike = numField(bestPut, "strike")!;
  if (callStrike !== putStrike) return null; // not a same-strike straddle
  const callMid = midPrice(bestCall);
  const putMid = midPrice(bestPut);
  if (callMid === null || putMid === null) return null;
  const expectedMovePct = ((callMid + putMid) / spot) * 100;
  if (!Number.isFinite(expectedMovePct) || expectedMovePct <= 0) return null;
  const ivOf = (o: Record<string, any>): number | null => {
    const g = o.greeks;
    if (!g || typeof g !== "object") return null;
    const v = (g as any).mid_iv ?? (g as any).iv;
    return typeof v === "number" && Number.isFinite(v) ? v * 100 : null; // Tradier IV is a decimal fraction
  };
  const callIv = ivOf(bestCall);
  const putIv = ivOf(bestPut);
  const iv = callIv !== null && putIv !== null ? (callIv + putIv) / 2 : (callIv ?? putIv);
  return { ticker: symbol, expiry: chosen.date, spot, expectedMovePct, iv };
}
