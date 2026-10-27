// Dashboard page. Queries Neon directly (a relative fetch of /api/leaderboard
// fails on the server with "Failed to parse URL from /api/leaderboard").
// force-dynamic so every visit shows the latest scans, shortlist and trades,
// not a build-time snapshot.
import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

type AnyRow = Record<string, any>;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function getData() {
  const sql = neon(process.env.DATABASE_URL!);

  const scans = await safe(
    () =>
      sql`SELECT id, scanned_at, market_status, universe, notes FROM scans ORDER BY id DESC LIMIT 10`,
    [] as AnyRow[],
  );
  const latestScan = scans[0] ?? null;
  const board = latestScan
    ? await safe(
        () =>
          sql`
            SELECT rank, ticker, company, price, change_1d_pct, change_5d_pct,
                   volume_ratio, score, catalyst, sentiment, reasoning, sources,
                   confidence, target_pct
            FROM leaderboard WHERE scan_id = ${latestScan.id} ORDER BY rank ASC
          `,
        [] as AnyRow[],
      )
    : [];

  const shortlist = await safe(
    () =>
      sql`
        SELECT ticker, company, catalyst_type, event_date, event_detail,
               reasoning, score, sources, is_new, created_at
        FROM weekly_shortlist
        WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
        ORDER BY score DESC LIMIT 50
      `,
    [] as AnyRow[],
  );

  const trades = await safe(
    () =>
      sql`
        SELECT week_start, ticker, leaderboard_rank, entry_price, notional_usd,
               alpaca_order_id, status, exit_price, pnl_pct, opened_at, closed_at
        FROM paper_trades ORDER BY opened_at DESC LIMIT 50
      `,
    [] as AnyRow[],
  );

  return { scans, latestScan, board, shortlist, trades };
}

const th: React.CSSProperties = { textAlign: "left", padding: "8px 6px", borderBottom: "2px solid #ddd", fontSize: 13 };
const td: React.CSSProperties = { padding: "8px 6px", borderTop: "1px solid #eee", fontSize: 13, verticalAlign: "top" };

function fmt(v: any) {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 16);
  return String(v);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 36 }}>
      <h2 style={{ fontSize: 20, marginBottom: 8 }}>{title}</h2>
      {children}
    </section>
  );
}

export default async function Page() {
  const { scans, latestScan, board, shortlist, trades } = await getData();
  const openTrades = trades.filter((t) => t.status === "open");
  const newToday = shortlist.filter((s) => s.is_new).length;

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>SPY Scanner Dashboard</h1>
      <p style={{ color: "#444" }}>
        Potential 5%+ rise within 1 week · Scans every 15 minutes, 24/7 · Daily catalyst shortlist of 50 · Paper trades $100 each, sell at +5% / −3%
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[
          ["Latest scan", latestScan ? `${fmt(latestScan.scanned_at)} · ${latestScan.market_status}` : "No scans yet"],
          ["Leaderboard rows", String(board.length)],
          ["Daily shortlist", shortlist.length ? `${shortlist.length} tickers · ${newToday} new · ${fmt(shortlist[0].created_at)}` : "No shortlist yet — run /api/weekly"],
          ["Paper trades open", String(openTrades.length)],
          ["Scans recorded", String(scans.length ? `${scans.length} shown (latest 10)` : "0")],
        ].map(([label, value]) => (
          <div key={label} style={{ border: "1px solid #ddd", borderRadius: 8, padding: "12px 16px", minWidth: 180 }}>
            <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{value}</div>
          </div>
        ))}
      </div>

      <Section title="Leaderboard — latest scan">
        {board.length === 0 ? (
          <p>No candidates in the latest scan. A scan with no verified catalyst produces no rows, rather than invented picks.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>#</th><th style={th}>Ticker</th><th style={th}>Score</th><th style={th}>Price</th>
              <th style={th}>1d / 5d</th><th style={th}>Catalyst</th><th style={th}>Sentiment</th><th style={th}>Reasoning</th>
            </tr></thead>
            <tbody>
              {board.map((r: any) => (
                <tr key={r.ticker}>
                  <td style={td}>{r.rank}</td>
                  <td style={td}><strong>{r.ticker}</strong><br /><span style={{ color: "#666" }}>{r.company ?? ""}</span></td>
                  <td style={td}>{r.score} ({r.confidence})</td>
                  <td style={td}>{r.price ?? "—"}</td>
                  <td style={td}>{r.change_1d_pct ?? "—"} / {r.change_5d_pct ?? "—"}</td>
                  <td style={td}>{r.catalyst ?? "—"}</td>
                  <td style={td}>{r.sentiment ?? "—"}</td>
                  <td style={td}>{r.reasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Daily catalyst shortlist — top 50">
        {shortlist.length === 0 ? (
          <p>No shortlist yet. This is built by the daily /api/weekly run (earnings, news, macro, geopolitical) and is the only universe the 15-minute scan covers.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Ticker</th><th style={th}>Score</th><th style={th}>Catalyst</th><th style={th}>Event</th><th style={th}>Reasoning</th>
            </tr></thead>
            <tbody>
              {shortlist.map((s: any) => (
                <tr key={s.ticker}>
                  <td style={td}>
                    <strong>{s.ticker}</strong>
                    {s.is_new ? <span style={{ marginLeft: 6, background: "#e6f4ea", color: "#137333", padding: "2px 6px", borderRadius: 10, fontSize: 11 }}>NEW</span> : null}
                    <br /><span style={{ color: "#666" }}>{s.company ?? ""}</span>
                  </td>
                  <td style={td}>{s.score}</td>
                  <td style={td}>{s.catalyst_type}</td>
                  <td style={td}>{s.event_date ? fmt(s.event_date) : "—"}<br /><span style={{ color: "#666" }}>{s.event_detail ?? ""}</span></td>
                  <td style={td}>{s.reasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Paper trades — Alpaca paper only, $100 each">
        {trades.length === 0 ? (
          <p>No paper trades yet. The daily /api/trade/daily job buys one unique leaderboard stock per day, $100 each; /api/trade/check closes at +5% or −3%.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Ticker</th><th style={th}>Week</th><th style={th}>Rank</th><th style={th}>Entry</th>
              <th style={th}>Exit</th><th style={th}>P&amp;L</th><th style={th}>Status</th><th style={th}>Opened</th>
            </tr></thead>
            <tbody>
              {trades.map((t: any, i: number) => (
                <tr key={`${t.ticker}-${i}`}>
                  <td style={td}><strong>{t.ticker}</strong></td>
                  <td style={td}>{fmt(t.week_start)}</td>
                  <td style={td}>{t.leaderboard_rank ?? "—"}</td>
                  <td style={td}>{t.entry_price ?? "—"} (${t.notional_usd})</td>
                  <td style={td}>{t.exit_price ?? "—"}</td>
                  <td style={td}>{t.pnl_pct ?? "—"}</td>
                  <td style={td}>{t.status}</td>
                  <td style={td}>{fmt(t.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Recent scans">
        {scans.length === 0 ? (
          <p>No scans recorded yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              <th style={th}>Scanned at</th><th style={th}>Market</th><th style={th}>Universe</th><th style={th}>Notes</th>
            </tr></thead>
            <tbody>
              {scans.map((s: any) => (
                <tr key={s.id}>
                  <td style={td}>{fmt(s.scanned_at)}</td>
                  <td style={td}>{s.market_status}</td>
                  <td style={td}>{s.universe}</td>
                  <td style={td}>{s.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <p style={{ color: "#666", marginTop: 36 }}>
        Screening only, not financial advice. Scores are not a guarantee of a 5% rise.
      </p>
    </main>
  );
}
