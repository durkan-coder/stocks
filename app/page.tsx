import { neon } from "@neondatabase/serverless";
import { getPositions } from "@/lib/alpaca";
import { computeTaxSummary, LONG_TERM_TAX_RATE, SHORT_TERM_TAX_RATE, taxRateFor } from "@/lib/tax";
import { repairParkedEntries } from "@/lib/taxPark";

// Portfolio home (Robinhood-style): positions first. This is the
// app's home screen — the scanner dashboard lives at /scanner.
// Top: total portfolio value + P/L. Below: a portfolio value chart
// and per-position sparklines, built ONLY from real stored prices
// (leaderboard scan prices since each purchase, never invented).
// Then a tabular positions table (shares, entry, current, P/L,
// take-profit, stop-loss) and a closed-positions table. Paper only.
export const dynamic = "force-dynamic";

type AnyRow = Record<string, any>;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtTime(v: any): string {
  if (v === null || v === undefined) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDate(v: any): string {
  if (v === null || v === undefined) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
}

function plColor(pct: number | null): string {
  if (pct === null) return "#5f6368";
  if (pct > 0.03) return "#137333";
  if (pct < -0.02) return "#a50e0e";
  return "#5f6368";
}

// SVG line + area path for a value series. X is by point order
// (scans are ~15 min apart, so order ≈ time); Y is zoomed to the
// series range, not zero-based — labelled as such on the chart,
// so a small move is visible without implying a larger one.
function chartPaths(values: number[], w: number, h: number, pad = 6): { line: string; area: string } {
  if (values.length === 0) return { line: "", area: "" };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const px = (i: number) => (values.length === 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2));
  const py = (v: number) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
  const area = `${line} L${px(values.length - 1).toFixed(1)},${h} L${px(0).toFixed(1)},${h} Z`;
  return { line, area };
}

export default async function PortfolioHome({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sql = neon(process.env.DATABASE_URL!);
  // Visible result banner for approve / reject / settings actions.
  // Those routes redirect here with ?notice=<code>&ticker=<TICKER>.
  // Previously they redirected to plain "/" with no message, so a
  // failed PIN and a successful buy looked identical (the PIN
  // field just cleared). Only whitelisted codes render, and the
  // ticker is only shown if it looks like a plain ticker symbol,
  // so a crafted URL cannot inject arbitrary banner text.
  const sp = searchParams ? await searchParams : {};
  const noticeRaw = Array.isArray(sp.notice) ? sp.notice[0] : sp.notice;
  const tickerRaw = Array.isArray(sp.ticker) ? sp.ticker[0] : sp.ticker;
  const noticeTicker = tickerRaw && /^[A-Z]{1,6}$/.test(tickerRaw) ? tickerRaw : "";
  const noticeText: Record<string, string> = {
    approved: `✓ ${noticeTicker} buy approved — $100 paper order placed at the current market price. Check Open positions and the journal for the Alpaca order ID.`,
    rejected: `✕ ${noticeTicker} proposal rejected for today only — no trade placed, and the ticker can be proposed again later.`,
    pin_invalid: "✕ Approval PIN was not accepted — nothing was changed. Check the PIN and try again. (Never share it in chat.)",
    guarded: `${noticeTicker} was not bought — it now fails a guard (score below 50, or a 1-day fall worse than −5%). The proposal was marked guarded and no order was placed.`,
    alpaca_failed: `${noticeTicker} was not bought — Alpaca rejected the order. The proposal stays pending so you can retry.`,
    expired: `${noticeTicker} proposal had expired (not from today), so nothing was bought.`,
    already_decided: `${noticeTicker} proposal was already decided, so nothing changed.`,
    already_bought: `${noticeTicker} was already bought before, so no duplicate order was placed.`,
    adhoc_bought: `✓ ${noticeTicker} bought ad-hoc — $100 at the current market price. It now shows as an open position below, with the same +3% / −2% levels.`,
    adhoc_failed: `✕ ${noticeTicker} was not bought — Alpaca rejected the order. Nothing was changed; try again later or during market hours.`,
    buy_invalid: "No valid ticker was given — type a stock symbol (e.g. NVDA) and try again.",
    already_open: `${noticeTicker} is already an open position — sell it first if you want to re-enter, or pick another ticker.`,
    no_proposal: "No pending proposal was found for that action — nothing was changed.",
    settings_on: "Approval mode turned ON — the daily run will propose a trade and buy nothing until you approve it.",
    settings_off: "Approval mode turned OFF — the daily run will buy directly, as before.",
    settings_invalid: "Approval setting was not changed — the value was not recognised.",
    sold_manual: `✓ ${noticeTicker} sold manually — the whole position was closed at the current market price. Check Closed positions and the journal for the exit price and P/L.`,
    sell_no_trade: "No open position was found for that sell — nothing was changed.",
    sell_no_position: `${noticeTicker} has no live Alpaca position to close — left open in the records. Check the journal; the broker position may already be gone.`,
    sell_alpaca_failed: `${noticeTicker} was not sold — Alpaca rejected the close. The position stays open so you can retry.`,
    sell_already_closed: `${noticeTicker} was already closed, so nothing changed.`,
    settings_auto_sell_on: "Automatic sells turned ON — the 15-minute check will close positions at +3% / −2% again.",
    settings_auto_sell_off: "Automatic sells turned OFF — sells are manual only. The 15-minute check watches the +3% / −2% levels and records when one is hit, but sells nothing.",
    daily_limit: `${noticeTicker} was not bought — today's buy limit is already reached. Raise "Buys per day" to approve more.`,
    settings_daily_count: "Buys per day updated — the daily run will now propose (or buy) up to that many tickers a day, $100 each.",
    tax_parked: "✓ Tax reserve parked — the un-parked tax amount was used to buy SGOV (money market ETF). It now shows as a position below.",
    tax_park_nothing: "Nothing to park right now — no tax is owed yet, or the un-parked amount is under $1 and will be swept on the next sale.",
    tax_park_failed: "✕ The tax park buy was not placed — Alpaca did not accept the order. The amount stays awaiting parking; try again later or during market hours.",
  };
  const notice = noticeRaw && noticeText[noticeRaw] ? noticeText[noticeRaw] : null;
  const noticeOk = noticeRaw === "approved" || noticeRaw === "rejected" || noticeRaw === "adhoc_bought" || noticeRaw === "settings_on" || noticeRaw === "settings_off" || noticeRaw === "sold_manual" || noticeRaw === "settings_auto_sell_on" || noticeRaw === "settings_auto_sell_off" || noticeRaw === "tax_parked" || noticeRaw === "tax_park_nothing" || noticeRaw === "settings_daily_count";
  // The tax-reserve column may not exist yet on the first load after
  // deploy; create it before the SELECT below, or the SELECT fails
  // and the whole portfolio renders empty.
  try {
    await sql`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS is_tax_reserve BOOLEAN NOT NULL DEFAULT false`;
  } catch { /* SELECT below falls back to empty on failure */ }
  // Self-heal: a park buy placed before extended_hours (or one
  // that had not filled yet) can leave an SGOV row with no entry
  // price, which renders as a row of dashes. Backfill it from the
  // order/quote before reading the trades below. Never blocks the
  // page if Alpaca is unreachable.
  try {
    await repairParkedEntries(sql);
  } catch { /* the row just renders as before */ }
  const trades = await safe(
    () =>
      sql`
        SELECT id, week_start, ticker, leaderboard_rank, entry_price, notional_usd,
               status, exit_price, pnl_pct, opened_at, closed_at, is_tax_reserve, alpaca_order_id
        FROM paper_trades ORDER BY opened_at DESC
      `,
    [] as AnyRow[],
  );

  const liveByTicker = new Map<string, any>();
  const live = await safe(() => getPositions(), [] as any[]);
  for (const p of live) liveByTicker.set(p.symbol, p);

  const cache = await safe(() => sql`SELECT ticker, price, change_pct, updated_at FROM price_cache`, [] as AnyRow[]);
  const cacheByTicker = new Map<string, AnyRow>();
  for (const c of cache) cacheByTicker.set(c.ticker, c);

  const board = await safe(
    () => sql`SELECT ticker, price FROM leaderboard WHERE scan_id = (SELECT MAX(id) FROM scans)`,
    [] as AnyRow[],
  );
  const boardByTicker = new Map<string, AnyRow>();
  for (const b of board) boardByTicker.set(b.ticker, b);

  // Scan-price history (last 3 days) for sparklines + portfolio chart.
  const historyRows = await safe(
    () =>
      sql`
        SELECT s.scanned_at, l.ticker, l.price
        FROM leaderboard l JOIN scans s ON s.id = l.scan_id
        WHERE s.scanned_at > NOW() - INTERVAL '3 days'
        ORDER BY s.scanned_at ASC
      `,
    [] as AnyRow[],
  );

  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status !== "open");

  // Human-in-the-loop: today's pending proposal, approval mode,
  // and recent proposal history. Tables are created by the trade
  // routes; if they do not exist yet, these fall back to empty.
  // PIN status only (never the value): whether APPROVAL_PIN is set
  // in Vercel. If it is not set, approve/reject/toggle are blocked
  // server-side until the user sets it and redeploys.
  const pinConfigured = Boolean(process.env.APPROVAL_PIN);
  let approvalOn = true;
  // Automatic sells: OFF unless explicitly turned on (manual-only
  // default since 2026-11-09). Missing row = off, matching
  // /api/trade/check, which is watch-only while this is off.
  let autoSellOn = false;
  // Buys per day (added 2026-11-10, Durkan: buy multiple stocks a
  // day): trade_settings 'daily_buy_count', integer 1-5, default 1.
  let dailyBuyCount = 1;
  try {
    await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    const setting = await sql`SELECT value FROM trade_settings WHERE key = 'human_approval' LIMIT 1`;
    if (setting.length > 0) approvalOn = setting[0].value !== "off";
    const autoSetting = await sql`SELECT value FROM trade_settings WHERE key = 'auto_sell' LIMIT 1`;
    if (autoSetting.length > 0) autoSellOn = autoSetting[0].value === "on";
    const countSetting = await sql`SELECT value FROM trade_settings WHERE key = 'daily_buy_count' LIMIT 1`;
    if (countSetting.length > 0) {
      const n = parseInt(String(countSetting[0].value), 10);
      if (Number.isFinite(n)) dailyBuyCount = Math.max(1, Math.min(5, n));
    }
  } catch {
    approvalOn = true;
    autoSellOn = false;
    dailyBuyCount = 1;
  }
  const pendingProposals = await safe(
    () =>
      sql`
        SELECT id, ticker, leaderboard_rank, score, price_at_proposal, catalyst, catalyst_type, event_date, status, created_at
        FROM trade_proposals
        WHERE status = 'pending' AND DATE(created_at) = CURRENT_DATE
        ORDER BY created_at ASC LIMIT 5
      `,
    [] as AnyRow[],
  );
  const proposals = pendingProposals;
  const recentProposals = await safe(
    () =>
      sql`
        SELECT id, ticker, leaderboard_rank, score, price_at_proposal, status, created_at, decided_at
        FROM trade_proposals ORDER BY created_at DESC LIMIT 5
      `,
    [] as AnyRow[],
  );
  // Sector for the concentration flag (same public mapping as the
  // scanner's sector leaders, compacted to the large names).
  const SECTOR: Record<string, string> = {
    AAPL: "Information Technology", MSFT: "Information Technology", NVDA: "Information Technology",
    AVGO: "Information Technology", AMD: "Information Technology", INTC: "Information Technology",
    CSCO: "Information Technology", ORCL: "Information Technology", CRM: "Information Technology",
    JPM: "Financials", V: "Financials", MA: "Financials", BAC: "Financials", WFC: "Financials", GS: "Financials",
    GOOGL: "Communication Services", META: "Communication Services", NFLX: "Communication Services", DIS: "Communication Services",
    LLY: "Health Care", JNJ: "Health Care", ABBV: "Health Care", UNH: "Health Care",
    AMZN: "Consumer Discretionary", TSLA: "Consumer Discretionary", HD: "Consumer Discretionary",
    GE: "Industrials", CAT: "Industrials", BA: "Industrials", HON: "Industrials",
    WMT: "Consumer Staples", COST: "Consumer Staples", PG: "Consumer Staples", KO: "Consumer Staples",
    XOM: "Energy", CVX: "Energy", NEE: "Utilities", PLD: "Real Estate", LIN: "Materials",
  };
  // Per-proposal flags (multi-buy: one card renders per pending
  // proposal, so these are computed per row at render time).
  const daysToEventFor = (p: AnyRow) => {
    if (!p || !p.event_date) return null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const ev = new Date(p.event_date);
    return Math.round((ev.getTime() - today.getTime()) / 86400000);
  };
  const sameSectorOpenFor = (p: AnyRow) => {
    const s = SECTOR[p.ticker];
    return s ? open.filter((t) => SECTOR[t.ticker] === s).map((t) => t.ticker) : [];
  };
  // Regime breadth (same definition as the daily gate): share of
  // fresh price_cache tickers up on the day. Weak = < 40%, which
  // raises the daily score floor from 50 to 75 for that run only.
  const regimeRows = await safe(
    () =>
      sql`
        SELECT COUNT(*)::int AS n,
          COALESCE(SUM(CASE WHEN change_pct > 0 THEN 1 ELSE 0 END), 0)::int AS up,
          COALESCE(AVG(change_pct), 0) AS avg_change,
          MAX(updated_at) AS at
        FROM price_cache
        WHERE updated_at > NOW() - INTERVAL '2 hours' AND change_pct IS NOT NULL
      `,
    [] as AnyRow[],
  );
  const regimeN = Number(regimeRows[0]?.n ?? 0);
  const regimeBreadth = regimeN >= 100 ? Math.round(((Number(regimeRows[0]?.up ?? 0) / regimeN) * 100) * 10) / 10 : null;
  const regimeStatus = regimeBreadth === null ? "data unavailable — gate inactive" : regimeBreadth < 40 ? "weak — daily score floor raised to 75" : "normal — score floor 50";

  const openRows = open.map((t) => {
    const entry = num(t.entry_price);
    const livePos = liveByTicker.get(t.ticker);
    let current: number | null = null;
    let plPct: number | null = null;
    let source = "Entry only";
    if (livePos) {
      current = num(livePos.current_price);
      const plpc = num(livePos.unrealized_plpc);
      plPct = plpc === null ? null : plpc * 100;
      source = "Live · Alpaca";
    } else if (cacheByTicker.get(t.ticker) !== undefined) {
      current = num(cacheByTicker.get(t.ticker)!.price);
      if (entry !== null && current !== null) plPct = ((current - entry) / entry) * 100;
      source = "Cached · staggered";
    } else if (boardByTicker.get(t.ticker) !== undefined) {
      current = num(boardByTicker.get(t.ticker)!.price);
      if (entry !== null && current !== null) plPct = ((current - entry) / entry) * 100;
      source = "Latest board";
    }
    // Tax-reserve rows are not on the board or in the staggered
    // cache, and the live position only exists once the buy fills.
    // Until then, value the row at its entry price (SGOV barely
    // moves) so it shows its parked value instead of dashes.
    const isReserveEarly = Boolean(t.is_tax_reserve);
    if (current === null && isReserveEarly && entry !== null) {
      current = entry;
      plPct = 0;
      source = "Pending fill — entry price";
    }
    const notional = num(t.notional_usd) ?? 100;
    const shares = entry !== null && entry > 0 ? notional / entry : null;
    const plUsd = plPct === null ? null : (plPct / 100) * notional;
    const currentValue = current !== null && shares !== null ? shares * current : null;
    // Day %: today's change vs yesterday's close, from the
    // staggered price cache (the 1-day % the quote feeds report —
    // Finnhub dp, TwelveData percent_change, FMP changesPercentage).
    // Only a row updated today counts; a stale row from yesterday
    // is not "today", so it shows "—" until the cache refreshes
    // (the stagger job runs every 5 minutes).
    const cacheRow = cacheByTicker.get(t.ticker);
    const cacheToday = cacheRow
      ? new Date(cacheRow.updated_at).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }) ===
        new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })
      : false;
    const dayPct = cacheToday ? num(cacheRow!.change_pct) : null;
    // Tax-reserve (SGOV) rows are the parking vehicle, not a trade:
    // the +3% / -2% levels never apply to them, so show no TP/SL.
    const isReserve = Boolean(t.is_tax_reserve);
    const tp = isReserve || entry === null ? null : entry * 1.03;
    const sl = isReserve || entry === null ? null : entry * 0.98;
    // Sparkline: this ticker's scan prices since purchase.
    const openedMs = new Date(t.opened_at).getTime();
    const spark = historyRows
      .filter((r) => r.ticker === t.ticker && num(r.price) !== null && new Date(r.scanned_at).getTime() >= openedMs)
      .map((r) => num(r.price)!);
    const sparkPoints = spark.length >= 2 ? spark : entry !== null && current !== null ? [entry, current] : spark;
    return { t, entry, current, plPct, plUsd, source, tp, sl, notional, shares, currentValue, spark: sparkPoints, isReserve, dayPct };
  });

  // Portfolio value series: at each scan time, sum shares × latest
  // scan price (carried forward) over positions opened by then.
  const portfolioSeries: { time: any; value: number }[] = [];
  if (openRows.length > 0) {
    const times = [...new Set(historyRows.map((r) => new Date(r.scanned_at).getTime()))].sort((a, b) => a - b);
    const lastPrice = new Map<string, number>();
    for (const ms of times) {
      for (const r of historyRows) {
        if (new Date(r.scanned_at).getTime() === ms && num(r.price) !== null) lastPrice.set(r.ticker, num(r.price)!);
      }
      let value = 0;
      let any = false;
      for (const row of openRows) {
        if (row.shares === null) continue;
        if (new Date(row.t.opened_at).getTime() > ms) continue;
        const p = lastPrice.get(row.t.ticker) ?? row.entry;
        if (p === null) continue;
        value += row.shares * p;
        any = true;
      }
      if (any) portfolioSeries.push({ time: new Date(ms), value });
    }
    // Ensure the series ends at today's live value.
    const liveTotal = openRows.reduce((s, r) => s + (r.currentValue ?? 0), 0);
    if (portfolioSeries.length > 0 && liveTotal > 0) {
      portfolioSeries.push({ time: new Date(), value: liveTotal });
    }
  }

  const invested = openRows.reduce((s, r) => s + r.notional, 0);
  const currentTotal = openRows.reduce((s, r) => s + (r.currentValue ?? 0), 0);
  const totalPlUsd = openRows.reduce((s, r) => s + (r.plUsd ?? 0), 0);
  const totalPlPct = invested > 0 ? (totalPlUsd / invested) * 100 : null;
  // pnl_pct is stored as a FRACTION (e.g. 0.032), matching the
  // check/sell routes and the journal — so $ P/L is pct * notional,
  // not pct / 100 * notional.
  const closedPlUsd = closed.reduce((s, t) => {
    const pct = num(t.pnl_pct);
    const notional = num(t.notional_usd) ?? 100;
    return s + (pct === null ? 0 : pct * notional);
  }, 0);

  // Tax reserve (2026): estimated tax on REALIZED gains only, at
  // the highest federal ceiling the user chose — 40.8% short-term
  // (37% + 3.8% NIIT), 23.8% long-term (20% + 3.8% NIIT) — with
  // losses netted first. The tax part is parked in SGOV (money
  // market ETF) as a REAL Alpaca paper position, bought the same
  // way as a stock buy; the rest is available to reinvest.
  // See lib/tax.ts (the math) and lib/taxPark.ts (the parking).
  const taxYear = new Date().getFullYear();
  const closedThisYear = closed.filter(
    (t) => t.closed_at && new Date(t.closed_at).getFullYear() === taxYear,
  );
  const tax = computeTaxSummary(closedThisYear as any[]);
  // Parked value = live value of the open SGOV tax-reserve
  // positions. Awaiting = tax owed but not yet parked (small
  // slices under the $1 buy minimum, or a park that failed).
  const parkedValue = openRows
    .filter((r) => r.isReserve)
    .reduce((s, r) => s + (r.currentValue ?? 0), 0);
  const awaitingParking = Math.max(0, tax.taxOwed - parkedValue);
  // "Sell now" preview for open winners: what the tax slice would
  // be if sold at the live price. Unrealised — no tax is owed
  // until a sale actually happens.
  const sellNowPreview = openRows
    .filter((r) => !r.isReserve && (r.plUsd ?? 0) > 0 && r.currentValue !== null)
    .map((r) => ({
      ticker: r.t.ticker,
      gainUsd: r.plUsd as number,
      taxUsd: (r.plUsd as number) * SHORT_TERM_TAX_RATE,
      proceedsUsd: r.currentValue as number,
    }));

  const chartValues = portfolioSeries.map((p) => p.value);
  const chart = chartPaths(chartValues, 600, 180);
  const chartColor = (totalPlPct ?? 0) >= 0 ? "#137333" : "#a50e0e";
  const chartMin = chartValues.length ? Math.min(...chartValues) : 0;
  const chartMax = chartValues.length ? Math.max(...chartValues) : 0;

  return (
    <main className="page">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #fff; }
        .page { max-width: 860px; margin: 0 auto; padding: 16px 16px 96px; font-family: system-ui, -apple-system, sans-serif; color: #202124; }
        .topnav { display: none; gap: 18px; font-size: 14px; margin: 4px 0 16px; }
        .topnav a { color: #5f6368; text-decoration: none; }
        .topnav a.active { color: #202124; font-weight: 700; }
        .hero-label { font-size: 13px; color: #5f6368; }
        .hero-value { font-size: 38px; font-weight: 800; margin: 2px 0 0; line-height: 1.1; }
        .hero-pl { font-size: 16px; font-weight: 700; margin-top: 4px; }
        .card { background: #fff; border: 1px solid #e0e4ea; border-radius: 18px; padding: 16px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .card h2 { font-size: 17px; margin: 0 0 4px; }
        .note { color: #5f6368; font-size: 12px; margin: 6px 0 0; line-height: 1.5; }
        .meta { color: #5f6368; font-size: 13px; margin-top: 4px; line-height: 1.45; }
        .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 16px; }
        .stat { background: #f6f8fb; border-radius: 12px; padding: 10px 12px; }
        .stat-label { font-size: 12px; color: #5f6368; }
        .stat-value { font-size: 15px; font-weight: 700; margin-top: 2px; }
        .table-wrap { overflow-x: auto; margin: 12px -16px 0; padding: 0 16px; }
        table { border-collapse: collapse; width: 100%; min-width: 640px; font-size: 13px; }
        th { text-align: left; color: #5f6368; font-weight: 600; padding: 8px 10px 8px 0; border-bottom: 1px solid #e0e4ea; white-space: nowrap; }
        td { padding: 10px 10px 10px 0; border-bottom: 1px solid #f0f2f5; white-space: nowrap; vertical-align: middle; }
        td.ticker, th.ticker { font-weight: 750; font-size: 14px; }
        .bottom-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 50; display: flex; background: #fff; border-top: 1px solid #e0e4ea; padding: 6px 4px calc(6px + env(safe-area-inset-bottom)); box-shadow: 0 -1px 6px rgba(0,0,0,0.06); }
        .bottom-nav a { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 2px; font-size: 10px; color: #5f6368; text-decoration: none; }
        .bottom-nav a.active { color: #0b1f3a; font-weight: 700; }
        .bottom-nav .nav-icon { font-size: 18px; line-height: 1; }
        .footer { color: #5f6368; font-size: 13px; margin: 24px 0 8px; text-align: center; }
        @media (min-width: 700px) {
          .page { padding: 24px 24px 32px; }
          .topnav { display: flex; }
          .bottom-nav { display: none; }
          .stats { grid-template-columns: repeat(4, 1fr); }
          .hero-value { font-size: 44px; }
        }
      `}</style>

      <nav className="topnav">
        <a className="active" href="/">🏠 Portfolio</a>
        <a href="/scanner">🔍 Scanner</a>
        <a href="/scanner#board">📊 Board</a>
        <a href="/scanner#trades">💼 Trades</a>
        <a href="/scanner#ask">💬 Ask</a>
      </nav>

      <div className="hero-label">Portfolio value · Paper only</div>
      <div className="hero-value">${currentTotal.toFixed(2)}</div>
      <div className="hero-pl" style={{ color: plColor(totalPlPct) }}>
        {totalPlPct === null ? "No open positions" : `${totalPlUsd >= 0 ? "+" : "−"}$${Math.abs(totalPlUsd).toFixed(2)} (${totalPlPct >= 0 ? "+" : ""}${totalPlPct.toFixed(2)}%) since purchase`}
      </div>
      <div className="meta">Invested ${invested.toFixed(2)} across {open.length} open position{open.length === 1 ? "" : "s"} · Closed P/L ${closedPlUsd >= 0 ? "+" : "−"}$${Math.abs(closedPlUsd).toFixed(2)}</div>

      {notice && (
        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, border: noticeOk ? "2px solid #137333" : "2px solid #a50e0e", background: noticeOk ? "#e6f4ea" : "#fdecea", color: "#0b1f3a", fontWeight: 700, fontSize: 15 }}>
          {notice}
        </div>
      )}

      <section className="card">
        <h2>Market regime</h2>
        <p className="meta">
          Breadth: {regimeBreadth === null ? "—" : `${regimeBreadth}% up`} across {regimeN} fresh staggered tickers · Status: <strong>{regimeStatus}</strong>
          {regimeBreadth !== null ? ` · Avg change ${Number(regimeRows[0]?.avg_change ?? 0).toFixed(2)}%` : ""}
        </p>
        <p className="note">Regime gate: breadth below 40% raises the daily score floor from 50 to 75 for that run only. If breadth data is stale or too thin, the gate is inactive rather than blocking trades on missing data. <a href="/journal">View trade journal →</a></p>
      </section>

      <section className="card">
        <h2>Trade approval — human in the loop</h2>
        <p className="meta">
          Approval mode is <strong>{approvalOn ? "ON" : "OFF"}</strong>. {approvalOn
            ? `The daily run proposes up to ${dailyBuyCount} trade${dailyBuyCount === 1 ? "" : "s"} and buys nothing until you approve ${dailyBuyCount === 1 ? "it" : "them"} here.`
            : `The daily run buys up to ${dailyBuyCount} ticker${dailyBuyCount === 1 ? "" : "s"} directly, as before.`}{" "}
          Sells are manual — a position closes only when you press Sell on it below. Automatic +3% / −2% sells are <strong>{autoSellOn ? "ON" : "OFF"}</strong>.
        </p>
        {!pinConfigured && (
          <p className="meta" style={{ color: "#a50e0e", fontWeight: 700 }}>
            ⚠️ Approval PIN is not set yet — approve, reject and toggle are blocked until you set APPROVAL_PIN in Vercel (Settings → Environment Variables, any 4–8 digit code you choose, different from CRON_SECRET, never shared in chat) and redeploy. Approvals will not work until then, by design.
          </p>
        )}
        <form method="post" action="/api/trade/settings" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="key" value="human_approval" />
          <input type="hidden" name="value" value={approvalOn ? "off" : "on"} />
          <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
          <button type="submit" style={{ padding: "10px 16px", borderRadius: 999, border: "1px solid #0b1f3a", background: "#0b1f3a", color: "#fff", fontSize: 14, cursor: "pointer" }}>
            Turn approval {approvalOn ? "OFF" : "ON"}
          </button>
        </form>
        <form method="post" action="/api/trade/settings" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="key" value="auto_sell" />
          <input type="hidden" name="value" value={autoSellOn ? "off" : "on"} />
          <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
          <button type="submit" style={{ padding: "10px 16px", borderRadius: 999, border: "1px solid #a50e0e", background: "#fff", color: "#a50e0e", fontSize: 14, cursor: "pointer" }}>
            Turn automatic sells {autoSellOn ? "OFF" : "ON"}
          </button>
          <span className="meta" style={{ marginTop: 0 }}>Automatic sells are {autoSellOn ? "ON — the 15-minute check closes at +3% / −2%." : "OFF — sells are manual only, and the 15-minute check only watches the levels."}</span>
        </form>
        <form method="post" action="/api/trade/settings" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="key" value="daily_buy_count" />
          <label className="meta" style={{ marginTop: 0 }}>Buys per day:</label>
          <select name="value" defaultValue={String(dailyBuyCount)} style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
          </select>
          <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
          <button type="submit" style={{ padding: "10px 16px", borderRadius: 999, border: "1px solid #0b1f3a", background: "#fff", color: "#0b1f3a", fontSize: 14, cursor: "pointer" }}>
            Set buys per day
          </button>
          <span className="meta" style={{ marginTop: 0 }}>The daily run proposes (or buys) up to this many never-bought tickers, in rank order — $100 each. Default 1.</span>
        </form>
        {proposals.length > 0 ? (
          proposals.map((proposal: AnyRow) => {
            const d = daysToEventFor(proposal);
            const sector = SECTOR[proposal.ticker];
            const sameSector = sameSectorOpenFor(proposal);
            const isPost = proposal.catalyst_type === "post_earnings";
            return (
              <div key={proposal.id} style={{ marginTop: 16, border: "2px solid #0b1f3a", borderRadius: 14, padding: 14 }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{proposal.ticker} — proposed buy, $100</div>
                <div className="meta">
                  Rank {proposal.leaderboard_rank ?? "—"} · Score {proposal.score ?? "—"} · Price at proposal ${proposal.price_at_proposal ?? "—"}
                  {proposal.catalyst_type ? ` · ${proposal.catalyst_type}` : ""}
                  {proposal.event_date ? ` · ${isPost ? "Reported" : "Event"} ${fmtDate(proposal.event_date)}` : ""}
                </div>
                <div className="meta">{proposal.catalyst ?? ""}</div>
                <div className="meta">
                  {isPost && d !== null
                    ? `📉 Reported ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago — post-earnings move: the report is behind it, so the risk is drift after the news, not a gap on the report. `
                    : ""}
                  {!isPost && d !== null && d <= 1
                    ? "⚠️ Earnings/event in " + d + " day(s) — high event risk: the move can gap straight past the stop. "
                    : ""}
                  {!isPost && d !== null && d > 1 ? `Event in ${d} days. ` : ""}
                  {sameSector.length > 0
                    ? `⚠️ Same sector (${sector}) as open position${sameSector.length === 1 ? "" : "s"}: ${sameSector.join(", ")} — this would concentrate that sector. `
                    : ""}
                  {Number(proposal.score) < 60 ? "Score is watch-range (< 60), not strong. " : ""}
                  Approval executes at the current market price for $100 notional — the proposal price is a reference, not a limit. Guards are re-checked at approval (score ≥ 50, 1-day fall &gt; −5%); if it now fails, no order is placed.
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <form method="post" action="/api/trade/approve" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input type="hidden" name="proposalId" value={String(proposal.id)} />
                    <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" required style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
                    <button type="submit" style={{ padding: "12px 20px", borderRadius: 999, border: "none", background: "#137333", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                      ✓ Approve buy
                    </button>
                  </form>
                  <form method="post" action="/api/trade/reject" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <input type="hidden" name="proposalId" value={String(proposal.id)} />
                    <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" required style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
                    <button type="submit" style={{ padding: "12px 20px", borderRadius: 999, border: "1px solid #a50e0e", background: "#fff", color: "#a50e0e", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                      ✕ Reject
                    </button>
                  </form>
                </div>
                <p className="note">Rejecting is for today only — the ticker stays never-bought and can be proposed again later if it still passes the guards. A proposal expires at the end of the day it was created.</p>
              </div>
            );
          })
        ) : (
          <p className="meta">No trade awaiting approval right now. The next proposal arrives with the next weekday daily run at 06:52 PDT (or with a manual Run now on the daily job).</p>
        )}
        {recentProposals.length > 0 && (
          <div className="meta" style={{ marginTop: 12 }}>
            Recent proposals: {recentProposals.map((r: any) => `${r.ticker} (${r.status})`).join(" · ")}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Buy a stock now</h2>
        <p className="meta">Buy $100 of any ticker on the spot — paper only, at the current market price. This is your call, not the scanner&apos;s: no score guard, no daily cap, and it works for tickers outside the leaderboard too. A ticker you already hold open can&apos;t be bought again here — sell it first if you want to re-enter.</p>
        <form method="post" action="/api/trade/buy" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="text" name="ticker" placeholder="Ticker, e.g. NVDA" autoComplete="off" autoCapitalize="characters" spellCheck={false} required style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 160, textTransform: "uppercase" }} />
          <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" required style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
          <button type="submit" style={{ padding: "12px 20px", borderRadius: 999, border: "none", background: "#137333", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
            Buy $100 now
          </button>
        </form>
        <p className="note">The buy executes at the current market price — the ticker you type is what gets bought, so double-check it before tapping. Once open, the usual +3% take-profit / −2% stop-loss levels apply, and sells stay manual.</p>
      </section>

      <section className="card">
        <h2>Portfolio over time</h2>
        {chartValues.length < 2 ? (
          <p className="meta">Not enough scan prices yet to draw a chart — it appears once the position has scan prices after purchase.</p>
        ) : (
          <>
            <svg viewBox="0 0 600 180" width="100%" height="180" role="img" aria-label="Portfolio value chart">
              <path d={chart.area} fill={chartColor} opacity="0.12" />
              <path d={chart.line} fill="none" stroke={chartColor} strokeWidth="2.5" strokeLinejoin="round" />
            </svg>
            <div className="meta">
              {fmtTime(portfolioSeries[0]?.time)} → {fmtTime(portfolioSeries[portfolioSeries.length - 1]?.time)} · Range ${chartMin.toFixed(2)} – ${chartMax.toFixed(2)} · Chart zoomed to range, not zero-based.
            </div>
          </>
        )}
        <p className="note">Built from leaderboard scan prices since each purchase. A position bought today starts at its entry value; earlier scan prices are not backfilled as if you had owned it.</p>
      </section>

      <div className="stats">
        <div className="stat"><div className="stat-label">Invested</div><div className="stat-value">${invested.toFixed(2)}</div></div>
        <div className="stat"><div className="stat-label">Current value</div><div className="stat-value">${currentTotal.toFixed(2)}</div></div>
        <div className="stat"><div className="stat-label">Open P/L</div><div className="stat-value" style={{ color: plColor(totalPlPct) }}>{totalPlPct === null ? "—" : `${totalPlUsd >= 0 ? "+" : "−"}$${Math.abs(totalPlUsd).toFixed(2)}`}</div></div>
        <div className="stat"><div className="stat-label">Open positions</div><div className="stat-value">{open.length}</div></div>
      </div>

      <section className="card">
        <h2>Open positions</h2>
        {openRows.length === 0 ? (
          <p className="meta">No open paper positions. The next daily buy runs on the next weekday at 06:52 PDT, subject to the score and fall guards.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="ticker">Stock</th><th>Trend</th><th>Shares</th><th>Entry</th><th>Price</th><th>P/L $</th><th>P/L %</th><th>Day %</th><th>Take profit</th><th>Stop loss</th><th>Sell</th></tr>
              </thead>
              <tbody>
                {openRows.map((r) => {
                  const spark = chartPaths(r.spark, 100, 32, 2);
                  const sparkColor = (r.plPct ?? 0) >= 0 ? "#137333" : "#a50e0e";
                  return (
                    <tr key={`${r.t.ticker}-${r.t.id}`}>
                      <td className="ticker">{r.t.ticker}<div className="meta" style={{ marginTop: 0 }}>{r.isReserve ? "Money market — tax reserve" : r.source}</div></td>
                      <td>
                        {r.spark.length >= 2 ? (
                          <svg viewBox="0 0 100 32" width="100" height="32"><path d={spark.line} fill="none" stroke={sparkColor} strokeWidth="2" strokeLinejoin="round" /></svg>
                        ) : "—"}
                      </td>
                      <td>{r.shares === null ? "—" : r.shares.toFixed(4)}</td>
                      <td>${r.entry === null ? "—" : r.entry.toFixed(2)}</td>
                      <td>${r.current === null ? "—" : r.current.toFixed(2)}</td>
                      <td style={{ color: plColor(r.plPct), fontWeight: 700 }}>{r.plUsd === null ? "—" : `${r.plUsd >= 0 ? "+" : "−"}$${Math.abs(r.plUsd).toFixed(2)}`}</td>
                      <td style={{ color: plColor(r.plPct), fontWeight: 700 }}>{r.plPct === null ? "—" : `${r.plPct >= 0 ? "+" : ""}${r.plPct.toFixed(2)}%`}</td>
                      <td style={{ color: r.dayPct === null || r.dayPct === 0 ? "#5f6368" : r.dayPct > 0 ? "#137333" : "#a50e0e", fontWeight: 700 }}>{r.dayPct === null ? "—" : `${r.dayPct >= 0 ? "+" : ""}${r.dayPct.toFixed(2)}%`}</td>
                      <td>${r.tp === null ? "—" : r.tp.toFixed(2)}</td>
                      <td>${r.sl === null ? "—" : r.sl.toFixed(2)}</td>
                      <td>
                        <form method="post" action="/api/trade/sell" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <input type="hidden" name="tradeId" value={String(r.t.id)} />
                          <input type="password" name="pin" placeholder="PIN" autoComplete="off" inputMode="numeric" required style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc", fontSize: 13, width: 84 }} />
                          <button type="submit" style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid #a50e0e", background: "#a50e0e", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Sell</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">P/L % is since you bought; Day % is today&apos;s change vs yesterday&apos;s close (from the staggered quote cache — &quot;—&quot; if it hasn&apos;t refreshed today). Sells are manual: press Sell on a position to close the whole thing at the current market price (PIN required). The +3% take-profit / −2% stop-loss levels are still your targets — the 15-minute check watches them and records when one is hit, but sells nothing while automatic sells are OFF. A gap at the open can move past a level before you sell — the levels guide, but do not guarantee, the exit. An SGOV row is your parked tax reserve (money market ETF), not a trade — the +3% / −2% levels never apply to it, and selling it is how you withdraw the parked money at tax time.</p>
      </section>

      <section className="card">
        <h2>Closed positions</h2>
        {closed.length === 0 ? (
          <p className="meta">No closed paper positions yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="ticker">Stock</th><th>Entry</th><th>Exit</th><th>P/L $</th><th>P/L %</th><th>Tax</th><th>Net</th><th>Status</th><th>Closed</th></tr>
              </thead>
              <tbody>
                {closed.map((t: any, i: number) => {
                  const pct = num(t.pnl_pct);
                  const notional = num(t.notional_usd) ?? 100;
                  const usd = pct === null ? null : pct * notional;
                  // Tax slice for this trade alone (gain x its rate,
                  // $0 on a loss). The headline tax owed in the Tax
                  // reserve card is NETTED across trades, so these
                  // slices can sum above it when losses exist.
                  // Tax-reserve (SGOV) rows are the parking vehicle:
                  // no tax is charged on them, net = full proceeds.
                  const isReserve = Boolean(t.is_tax_reserve);
                  const rate = taxRateFor(t);
                  const taxSlice = isReserve || usd === null || usd <= 0 ? 0 : usd * rate;
                  const net = usd === null ? null : notional + usd - taxSlice;
                  return (
                    <tr key={`${t.ticker}-${i}`}>
                      <td className="ticker">{t.ticker}{isReserve ? <div className="meta" style={{ marginTop: 0 }}>Money market — tax reserve</div> : null}</td>
                      <td>{t.entry_price ?? "—"}</td>
                      <td>{t.exit_price ?? "—"}</td>
                      <td style={{ color: plColor(pct), fontWeight: 700 }}>{usd === null ? "—" : `${usd >= 0 ? "+" : "−"}$${Math.abs(usd).toFixed(2)}`}</td>
                      <td style={{ color: plColor(pct), fontWeight: 700 }}>{pct === null ? "—" : `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(2)}%`}</td>
                      <td>{isReserve ? "—" : <>${taxSlice.toFixed(2)} <span className="meta">({(rate * 100).toFixed(1)}%)</span></>}</td>
                      <td style={{ fontWeight: 700 }}>{net === null ? "—" : `$${net.toFixed(2)}`}</td>
                      <td>{t.status}</td>
                      <td>{fmtDate(t.closed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Tax reserve — {taxYear}</h2>
        <p className="meta">
          Estimated tax on realized gains only, at the highest federal ceiling: <strong>{(SHORT_TERM_TAX_RATE * 100).toFixed(1)}% short-term</strong> (37% + 3.8% NIIT) and <strong>{(LONG_TERM_TAX_RATE * 100).toFixed(1)}% long-term</strong> (20% + 3.8% NIIT). Losses are netted against gains first. Federal only — no state tax included.
        </p>
        {tax.tradeCount === 0 ? (
          <p className="meta">No sales yet in {taxYear} — the reserve fills when you sell a position. The preview below shows what the tax slice would be if you sold a winner now.</p>
        ) : (
          <div className="stats" style={{ marginTop: 10 }}>
            <div className="stat"><div className="stat-label">Realized gains</div><div className="stat-value">${(tax.stGains + tax.ltGains).toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Realized losses</div><div className="stat-value">${tax.stLosses + tax.ltLosses === 0 ? "0.00" : (tax.stLosses + tax.ltLosses).toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Net taxable gain</div><div className="stat-value">${(tax.taxableSt + tax.taxableLt).toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Estimated tax owed</div><div className="stat-value">${tax.taxOwed.toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Parked in SGOV (live value)</div><div className="stat-value">${parkedValue.toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Awaiting parking</div><div className="stat-value">${awaitingParking.toFixed(2)}</div></div>
            <div className="stat"><div className="stat-label">Available to reinvest</div><div className="stat-value">${tax.reinvestable.toFixed(2)}</div></div>
          </div>
        )}
        {tax.tradeCount > 0 && (
          <p className="meta" style={{ marginTop: 8 }}>
            Short-term net ${tax.stNet.toFixed(2)} · Long-term net ${tax.ltNet.toFixed(2)} · Sale proceeds ${tax.totalProceeds.toFixed(2)} — tax ${tax.taxOwed.toFixed(2)} owed, ${parkedValue.toFixed(2)} parked in SGOV, ${awaitingParking.toFixed(2)} awaiting parking, and the remaining ${tax.reinvestable.toFixed(2)} is available to reinvest.
          </p>
        )}
        {awaitingParking >= 1 && (
          <form method="post" action="/api/trade/tax-park" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" required style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14, width: 140 }} />
            <button type="submit" style={{ padding: "10px 16px", borderRadius: 999, border: "1px solid #0b1f3a", background: "#0b1f3a", color: "#fff", fontSize: 14, cursor: "pointer" }}>
              Park ${awaitingParking.toFixed(2)} in SGOV now
            </button>
            <span className="meta" style={{ marginTop: 0 }}>Buys SGOV at the market price, the same way a stock buy works. Future sales park automatically — this button is only for what is still waiting.</span>
          </form>
        )}
        {sellNowPreview.length > 0 && (
          <>
            <p className="meta" style={{ marginTop: 12, fontWeight: 700 }}>If you sold now (preview — unrealised, no tax until you sell):</p>
            <div className="meta">
              {sellNowPreview.map((p) => `${p.ticker}: gain $${p.gainUsd.toFixed(2)} → tax $${p.taxUsd.toFixed(2)} parked, $${(p.proceedsUsd - p.taxUsd).toFixed(2)} to reinvest`).join(" · ")}
            </div>
          </>
        )}
        <p className="note">Estimate for planning only — not tax advice. Your actual bill depends on your full income, filing status, and state. The parked money is a real SGOV position (iShares 0-3 Month Treasury Bond ETF — T-bills, price near $100, monthly dividend; Alpaca has no money market fund product, so this is the closest parking vehicle). Selling the SGOV position is how you withdraw the parked money at tax time. Wash sales are not tracked.</p>
      </section>

      <nav className="bottom-nav">
        <a className="active" href="/"><span className="nav-icon">🏠</span>Portfolio</a>
        <a href="/scanner"><span className="nav-icon">🔍</span>Scanner</a>
        <a href="/scanner#board"><span className="nav-icon">📊</span>Board</a>
        <a href="/scanner#ask"><span className="nav-icon">💬</span>Ask</a>
      </nav>

      <p className="footer">Paper trading only — not real money, screening only, not financial advice. <a href="/scanner">Open the scanner →</a></p>
    </main>
  );
}
