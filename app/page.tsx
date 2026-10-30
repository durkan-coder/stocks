import { neon } from "@neondatabase/serverless";
import { getPositions } from "@/lib/alpaca";

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
  if (pct > 0.05) return "#137333";
  if (pct < -0.05) return "#a50e0e";
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

export default async function PortfolioHome() {
  const sql = neon(process.env.DATABASE_URL!);
  const trades = await safe(
    () =>
      sql`
        SELECT week_start, ticker, leaderboard_rank, entry_price, notional_usd,
               status, exit_price, pnl_pct, opened_at, closed_at
        FROM paper_trades ORDER BY opened_at DESC
      `,
    [] as AnyRow[],
  );

  const liveByTicker = new Map<string, any>();
  const live = await safe(() => getPositions(), [] as any[]);
  for (const p of live) liveByTicker.set(p.symbol, p);

  const cache = await safe(() => sql`SELECT ticker, price, updated_at FROM price_cache`, [] as AnyRow[]);
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
    const notional = num(t.notional_usd) ?? 100;
    const shares = entry !== null && entry > 0 ? notional / entry : null;
    const plUsd = plPct === null ? null : (plPct / 100) * notional;
    const currentValue = current !== null && shares !== null ? shares * current : null;
    const tp = entry === null ? null : entry * 1.05;
    const sl = entry === null ? null : entry * 0.97;
    // Sparkline: this ticker's scan prices since purchase.
    const openedMs = new Date(t.opened_at).getTime();
    const spark = historyRows
      .filter((r) => r.ticker === t.ticker && num(r.price) !== null && new Date(r.scanned_at).getTime() >= openedMs)
      .map((r) => num(r.price)!);
    const sparkPoints = spark.length >= 2 ? spark : entry !== null && current !== null ? [entry, current] : spark;
    return { t, entry, current, plPct, plUsd, source, tp, sl, notional, shares, currentValue, spark: sparkPoints };
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
  const closedPlUsd = closed.reduce((s, t) => {
    const pct = num(t.pnl_pct);
    const notional = num(t.notional_usd) ?? 100;
    return s + (pct === null ? 0 : (pct / 100) * notional);
  }, 0);

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
        {totalPlPct === null ? "No open positions" : `${totalPlUsd >= 0 ? "+" : "−"}$${Math.abs(totalPlUsd).toFixed(2)} (${totalPlPct >= 0 ? "+" : ""}${totalPlPct.toFixed(2)}%) today / since purchase`}
      </div>
      <div className="meta">Invested ${invested.toFixed(2)} across {open.length} open position{open.length === 1 ? "" : "s"} · Closed P/L ${closedPlUsd >= 0 ? "+" : "−"}$${Math.abs(closedPlUsd).toFixed(2)}</div>

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
                <tr><th className="ticker">Stock</th><th>Trend</th><th>Shares</th><th>Entry</th><th>Price</th><th>P/L $</th><th>P/L %</th><th>Take profit</th><th>Stop loss</th></tr>
              </thead>
              <tbody>
                {openRows.map((r) => {
                  const spark = chartPaths(r.spark, 100, 32, 2);
                  const sparkColor = (r.plPct ?? 0) >= 0 ? "#137333" : "#a50e0e";
                  return (
                    <tr key={r.t.ticker}>
                      <td className="ticker">{r.t.ticker}<div className="meta" style={{ marginTop: 0 }}>{r.source}</div></td>
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
                      <td>${r.tp === null ? "—" : r.tp.toFixed(2)}</td>
                      <td>${r.sl === null ? "—" : r.sl.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">Sell rule: +5% take profit, −3% stop loss, checked every 15 minutes. A gap at the open can close beyond −3% — the stop limits, but does not guarantee, the loss.</p>
      </section>

      <section className="card">
        <h2>Closed positions</h2>
        {closed.length === 0 ? (
          <p className="meta">No closed paper positions yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="ticker">Stock</th><th>Entry</th><th>Exit</th><th>P/L $</th><th>P/L %</th><th>Status</th><th>Closed</th></tr>
              </thead>
              <tbody>
                {closed.map((t: any, i: number) => {
                  const pct = num(t.pnl_pct);
                  const notional = num(t.notional_usd) ?? 100;
                  const usd = pct === null ? null : (pct / 100) * notional;
                  return (
                    <tr key={`${t.ticker}-${i}`}>
                      <td className="ticker">{t.ticker}</td>
                      <td>{t.entry_price ?? "—"}</td>
                      <td>{t.exit_price ?? "—"}</td>
                      <td style={{ color: plColor(pct), fontWeight: 700 }}>{usd === null ? "—" : `${usd >= 0 ? "+" : "−"}$${Math.abs(usd).toFixed(2)}`}</td>
                      <td style={{ color: plColor(pct), fontWeight: 700 }}>{pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}</td>
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
