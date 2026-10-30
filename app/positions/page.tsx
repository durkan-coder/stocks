import { neon } from "@neondatabase/serverless";
import { getPositions } from "@/lib/alpaca";

// Positions screen: every paper trade, open and closed, with live
// profit / loss. Open P/L comes from Alpaca's own positions first
// (current_price + unrealized_plpc — the same figures /api/trade/check
// uses for the +5% / -3% sell rule), falling back to the staggered
// price_cache, then to the latest leaderboard price, then to entry
// only. Closed P/L comes from Neon (exit_price / pnl_pct written at
// close). Paper only, $100 per trade. No keys or order IDs are shown.
export const dynamic = "force-dynamic";

type AnyRow = Record<string, any>;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function fmt(v: any): string {
  if (v === null || v === undefined) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function plColor(pct: number | null): string {
  if (pct === null) return "#5f6368";
  if (pct > 0.05) return "#137333";
  if (pct < -0.05) return "#a50e0e";
  return "#5f6368";
}

export default async function PositionsPage() {
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

  // Live Alpaca positions (open only), fail-soft: any Alpaca error
  // leaves liveByTicker empty and the fallbacks below take over.
  const liveByTicker = new Map<string, any>();
  const live = await safe(() => getPositions(), [] as any[]);
  for (const p of live) liveByTicker.set(p.symbol, p);

  const cache = await safe(
    () => sql`SELECT ticker, price, updated_at FROM price_cache`,
    [] as AnyRow[],
  );
  const cacheByTicker = new Map<string, AnyRow>();
  for (const c of cache) cacheByTicker.set(c.ticker, c);

  const board = await safe(
    () =>
      sql`
        SELECT ticker, price FROM leaderboard
        WHERE scan_id = (SELECT MAX(id) FROM scans)
      `,
    [] as AnyRow[],
  );
  const boardByTicker = new Map<string, AnyRow>();
  for (const b of board) boardByTicker.set(b.ticker, b);

  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status !== "open");

  const openRows = open.map((t) => {
    const entry = num(t.entry_price);
    const livePos = liveByTicker.get(t.ticker);
    let current: number | null = null;
    let plPct: number | null = null;
    let source = "Entry only — no live price yet";
    if (livePos) {
      current = num(livePos.current_price);
      const plpc = num(livePos.unrealized_plpc);
      plPct = plpc === null ? null : plpc * 100;
      source = "Live — Alpaca paper position";
    } else if (cacheByTicker.get(t.ticker) !== undefined) {
      const cached = cacheByTicker.get(t.ticker)!;
      current = num(cached.price);
      if (entry !== null && current !== null) plPct = ((current - entry) / entry) * 100;
      source = `Cached price — staggered quotes, ${fmt(cached.updated_at)}`;
    } else if (boardByTicker.get(t.ticker) !== undefined) {
      const boardRow = boardByTicker.get(t.ticker)!;
      current = num(boardRow.price);
      if (entry !== null && current !== null) plPct = ((current - entry) / entry) * 100;
      source = "Latest leaderboard price";
    }
    const notional = num(t.notional_usd) ?? 100;
    const plUsd = plPct === null ? null : (plPct / 100) * notional;
    const tp = entry === null ? null : entry * 1.05;
    const sl = entry === null ? null : entry * 0.97;
    return { t, entry, current, plPct, plUsd, source, tp, sl, notional };
  });

  const openPlUsd = openRows.reduce((s, r) => s + (r.plUsd ?? 0), 0);
  const openInvested = openRows.reduce((s, r) => s + r.notional, 0);
  const openPlPct = openInvested > 0 ? (openPlUsd / openInvested) * 100 : null;
  const closedPlUsd = closed.reduce((s, t) => {
    const pct = num(t.pnl_pct);
    const notional = num(t.notional_usd) ?? 100;
    return s + (pct === null ? 0 : (pct / 100) * notional);
  }, 0);
  const closedWithPl = closed.filter((t) => num(t.pnl_pct) !== null).length;

  return (
    <main className="page">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f6f8fb; }
        .page { max-width: 860px; margin: 0 auto; padding: 16px; font-family: system-ui, -apple-system, sans-serif; color: #202124; }
        .page h1 { font-size: 26px; margin: 8px 0 4px; }
        .subtitle { color: #5f6368; font-size: 14px; margin: 0 0 16px; line-height: 1.5; }
        .back { font-size: 14px; }
        .status-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
        .status-card { background: #fff; border: 1px solid #e0e4ea; border-radius: 14px; padding: 12px 14px; }
        .status-label { font-size: 12px; color: #5f6368; }
        .status-value { font-size: 15px; font-weight: 650; margin-top: 4px; line-height: 1.3; }
        .section { background: #fff; border: 1px solid #e0e4ea; border-radius: 18px; padding: 16px; margin-top: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
        .section h2 { font-size: 19px; margin: 0 0 4px; }
        .section-note { color: #5f6368; font-size: 13px; margin: 0 0 12px; line-height: 1.5; }
        .cards { display: flex; flex-direction: column; gap: 10px; }
        .row-card { border: 1px solid #e8eaed; border-radius: 14px; padding: 12px 14px; background: #fbfcfe; }
        .row-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .ticker { font-size: 18px; font-weight: 750; }
        .company { color: #5f6368; font-size: 12px; margin-top: 2px; }
        .badge { font-size: 13px; font-weight: 700; white-space: nowrap; }
        .price { font-size: 16px; font-weight: 650; margin-top: 8px; }
        .pl { font-size: 20px; font-weight: 800; margin-top: 8px; }
        .meta { color: #5f6368; font-size: 13px; margin-top: 4px; line-height: 1.45; }
        .footer { color: #5f6368; font-size: 13px; margin: 24px 0 8px; text-align: center; }
        @media (min-width: 700px) {
          .page { padding: 24px; }
          .page h1 { font-size: 30px; }
          .status-grid { grid-template-columns: repeat(3, 1fr); }
          .cards { display: grid; grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <p className="back"><a href="/">← Back to dashboard</a></p>
      <h1>Positions — paper only</h1>
      <p className="subtitle">
        Every paper trade, $100 each. Open positions show live profit/loss; closed positions show the realised result. Sell rule: +5% take profit, −3% stop loss, checked every 15 minutes.
      </p>

      <div className="status-grid">
        {[
          ["Open positions", String(open.length)],
          ["Open invested", `$${openInvested.toFixed(0)}`],
          ["Open P/L", openPlPct === null ? "—" : `${openPlPct >= 0 ? "+" : ""}${openPlPct.toFixed(2)}% · $${openPlUsd >= 0 ? "+" : ""}${openPlUsd.toFixed(2)}`],
          ["Closed positions", String(closed.length)],
          ["Closed P/L", closedWithPl === 0 ? "—" : `$${closedPlUsd >= 0 ? "+" : ""}${closedPlUsd.toFixed(2)}`],
          ["All trades", String(trades.length)],
        ].map(([label, value]) => (
          <div key={label} className="status-card">
            <div className="status-label">{label}</div>
            <div className="status-value">{value}</div>
          </div>
        ))}
      </div>

      <section className="section">
        <h2>Open positions</h2>
        <p className="section-note">Current price and P/L per position. Take-profit and stop-loss prices are entry × 1.05 and entry × 0.97.</p>
        {openRows.length === 0 ? (
          <p>No open paper positions.</p>
        ) : (
          <div className="cards">
            {openRows.map((r) => (
              <div key={r.t.ticker} className="row-card">
                <div className="row-top">
                  <div>
                    <div className="ticker">{r.t.ticker}</div>
                    <div className="company">Week of {fmt(r.t.week_start)} · Rank {r.t.leaderboard_rank ?? "—"} · Opened {fmt(r.t.opened_at)}</div>
                  </div>
                  <div className="badge" style={{ color: plColor(r.plPct) }}>
                    {r.plPct === null ? "—" : `${r.plPct >= 0 ? "+" : ""}${r.plPct.toFixed(2)}%`}
                  </div>
                </div>
                <div className="pl" style={{ color: plColor(r.plPct) }}>
                  {r.plUsd === null ? "P/L —" : `${r.plUsd >= 0 ? "+" : "−"}$${Math.abs(r.plUsd).toFixed(2)}`}
                </div>
                <div className="meta">
                  Entry ${r.entry === null ? "—" : r.entry.toFixed(2)} (${r.notional}) · Now ${r.current === null ? "—" : `$${r.current.toFixed(2)}`}
                </div>
                <div className="meta">
                  Take profit ${r.tp === null ? "—" : `$${r.tp.toFixed(2)}`} · Stop loss ${r.sl === null ? "—" : `$${r.sl.toFixed(2)}`}
                </div>
                <div className="meta">{r.source}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Closed positions</h2>
        <p className="section-note">Realised result as recorded at close.</p>
        {closed.length === 0 ? (
          <p>No closed paper positions yet.</p>
        ) : (
          <div className="cards">
            {closed.map((t: any, i: number) => {
              const pct = num(t.pnl_pct);
              const notional = num(t.notional_usd) ?? 100;
              const usd = pct === null ? null : (pct / 100) * notional;
              return (
                <div key={`${t.ticker}-${i}`} className="row-card">
                  <div className="row-top">
                    <div>
                      <div className="ticker">{t.ticker}</div>
                      <div className="company">Week of {fmt(t.week_start)} · Rank {t.leaderboard_rank ?? "—"}</div>
                    </div>
                    <div className="badge" style={{ color: plColor(pct) }}>{t.status}</div>
                  </div>
                  <div className="pl" style={{ color: plColor(pct) }}>
                    {usd === null ? "P/L —" : `${usd >= 0 ? "+" : "−"}$${Math.abs(usd).toFixed(2)}${pct === null ? "" : ` (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`}`}
                  </div>
                  <div className="meta">
                    Entry {t.entry_price ?? "—"} · Exit {t.exit_price ?? "—"}
                  </div>
                  <div className="meta">Opened {fmt(t.opened_at)}{t.closed_at ? ` · Closed ${fmt(t.closed_at)}` : ""}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="footer">Paper trading only — not real money, screening only, not financial advice.</p>
    </main>
  );
}
