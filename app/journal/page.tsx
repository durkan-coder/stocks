import { neon } from "@neondatabase/serverless";

// Verified trade journal: every paper trade, every proposal
// decision, and every recorded daily-run attempt, from Neon —
// nothing invented, nothing summarised away. Paper only.
//
// "Verified" here means: each trade row carries the Alpaca order
// id returned when the order was placed, and each proposal row
// carries its decision and timestamp, so any row can be
// cross-checked in the Alpaca paper dashboard by order id.
// This page is NOT a broker statement — it is the app's own
// record of what it asked Alpaca to do. Rejected proposals show
// no trade and no fabricated would-be P/L; their outcome, if
// any, appears later in the backtest once that ticker's 7-day
// window is evaluated.
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

export default async function Journal() {
  const sql = neon(process.env.DATABASE_URL!);
  const trades = await safe(
    () =>
      sql`
        SELECT week_start, ticker, leaderboard_rank, entry_price, notional_usd,
               alpaca_order_id, status, exit_price, pnl_pct, opened_at, closed_at
        FROM paper_trades ORDER BY opened_at DESC LIMIT 100
      `,
    [] as AnyRow[],
  );
  const proposals = await safe(
    () =>
      sql`
        SELECT id, ticker, leaderboard_rank, score, price_at_proposal, catalyst, catalyst_type, event_date, status, created_at, decided_at
        FROM trade_proposals ORDER BY created_at DESC LIMIT 100
      `,
    [] as AnyRow[],
  );
  const attempts = await safe(
    () =>
      sql`
        SELECT job, scan_id, ticker, leaderboard_rank, outcome, detail, created_at
        FROM trade_attempts ORDER BY created_at DESC LIMIT 50
      `,
    [] as AnyRow[],
  );

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24 }}>Trade journal</h1>
      <p style={{ color: "#5f6368" }}>
        Paper only. Every trade, proposal decision, and daily-run attempt, from the database.{" "}
        <a href="/">← Portfolio home</a> · <a href="/scanner">Scanner →</a>
      </p>

      <section>
        <h2>Paper trades ({trades.length})</h2>
        {trades.length === 0 ? (
          <p>No paper trades yet.</p>
        ) : (
          trades.map((t: any, i: number) => (
            <div key={i} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{t.ticker} — {t.status}</div>
              <div style={{ color: "#5f6368", fontSize: 13 }}>
                Rank {t.leaderboard_rank ?? "—"} · Entry ${t.entry_price ?? "—"} · Notional ${t.notional_usd ?? "—"} ·
                Exit {t.exit_price ?? "—"} · P/L {t.pnl_pct === null ? "—" : `${(Number(t.pnl_pct) * 100).toFixed(2)}%`} ·
                Opened {fmt(t.opened_at)}{t.closed_at ? ` · Closed ${fmt(t.closed_at)}` : ""}
              </div>
              <div style={{ color: "#5f6368", fontSize: 12 }}>Alpaca order: {t.alpaca_order_id ?? "—"}</div>
            </div>
          ))
        )}
      </section>

      <section>
        <h2>Proposals ({proposals.length})</h2>
        {proposals.length === 0 ? (
          <p>No proposals yet — the first arrives with the next weekday daily run that passes the guards.</p>
        ) : (
          proposals.map((p: any) => (
            <div key={p.id} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{p.ticker} — {p.status}</div>
              <div style={{ color: "#5f6368", fontSize: 13 }}>
                Rank {p.leaderboard_rank ?? "—"} · Score {p.score ?? "—"} · Price at proposal ${p.price_at_proposal ?? "—"} ·
                {p.catalyst_type ? ` ${p.catalyst_type}` : ""} · Created {fmt(p.created_at)}
                {p.decided_at ? ` · Decided ${fmt(p.decided_at)}` : ""}
              </div>
              <div style={{ color: "#5f6368", fontSize: 13 }}>{p.catalyst ?? ""}</div>
            </div>
          ))
        )}
      </section>

      <section>
        <h2>Daily-run attempts (latest {attempts.length})</h2>
        {attempts.length === 0 ? (
          <p>No recorded attempts yet.</p>
        ) : (
          attempts.map((a: any, i: number) => (
            <div key={i} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 700 }}>{a.outcome}{a.ticker ? ` — ${a.ticker}` : ""}</div>
              <div style={{ color: "#5f6368", fontSize: 13 }}>
                {fmt(a.created_at)} · Scan {a.scan_id ?? "—"} · Rank {a.leaderboard_rank ?? "—"}
              </div>
              {a.detail ? <div style={{ color: "#5f6368", fontSize: 13 }}>{a.detail}</div> : null}
            </div>
          ))
        )}
      </section>
      <p style={{ color: "#5f6368", fontSize: 12 }}>
        Note: a rejected proposal has no trade row by design. Its would-be outcome is not shown here, because it would have to be
        reconstructed after the fact — the backtest, not this journal, is where pick outcomes are measured.
      </p>
    </main>
  );
}
