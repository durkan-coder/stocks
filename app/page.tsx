// Dashboard page — mobile-first, iPhone-first.
// Queries Neon directly (a relative fetch of /api/leaderboard fails on
// the server with "Failed to parse URL from /api/leaderboard").
// force-dynamic so every visit shows the latest scans, shortlist and
// trades, not a build-time snapshot.
//
// Layout: one column on phones, cards instead of wide tables, so
// nothing overflows horizontally and every area is its own visibly
// separated section: status, chat, leaderboard, sector leaders,
// shortlist, paper trades, recent scans.
import { neon } from "@neondatabase/serverless";
import ChatBox from "./components/ChatBox";

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

// GICS sector leaders: for each of the 11 official GICS sectors, the
// highest-scoring ticker in the latest scan THAT ALREADY HAS a named
// catalyst (every leaderboard row does, by construction). A sector
// with no catalyst-backed ticker this scan is shown as empty —
// never filled with a weak, catalyst-free row just to complete the
// set, which would dilute the 5% screening signal.
//
// Sector mapping is a hardcoded ticker -> GICS sector table covering
// the scanner's current universe and the usual large SPY names. It is
// incomplete by design: tickers not in this map are simply not shown
// as sector leaders, rather than guessed. When the live FMP
// constituents list works again, sector should come from that list
// (which carries a sector field per constituent) instead of this map.
const GICS_SECTORS = [
  "Information Technology",
  "Financials",
  "Communication Services",
  "Health Care",
  "Consumer Discretionary",
  "Industrials",
  "Consumer Staples",
  "Energy",
  "Utilities",
  "Real Estate",
  "Materials",
] as const;

const TICKER_SECTOR: Record<string, string> = {
  NVDA: "Information Technology", AAPL: "Information Technology", MSFT: "Information Technology",
  AVGO: "Information Technology", AMD: "Information Technology", INTC: "Information Technology",
  CSCO: "Information Technology", ORCL: "Information Technology", CRM: "Information Technology",
  JPM: "Financials", V: "Financials", MA: "Financials", BAC: "Financials", WFC: "Financials", GS: "Financials",
  GOOGL: "Communication Services", GOOG: "Communication Services", META: "Communication Services",
  NFLX: "Communication Services", DIS: "Communication Services", VZ: "Communication Services",
  LLY: "Health Care", JNJ: "Health Care", ABBV: "Health Care", UNH: "Health Care", MRK: "Health Care",
  AMZN: "Consumer Discretionary", TSLA: "Consumer Discretionary", HD: "Consumer Discretionary",
  MCD: "Consumer Discretionary", BKNG: "Consumer Discretionary",
  GE: "Industrials", CAT: "Industrials", RTX: "Industrials", HON: "Industrials", UNP: "Industrials",
  BA: "Industrials", LMT: "Industrials", NOC: "Industrials",
  WMT: "Consumer Staples", COST: "Consumer Staples", PG: "Consumer Staples", KO: "Consumer Staples", PEP: "Consumer Staples",
  XOM: "Energy", CVX: "Energy", COP: "Energy", SLB: "Energy",
  NEE: "Utilities", SO: "Utilities", DUK: "Utilities", CEG: "Utilities",
  PLD: "Real Estate", AMT: "Real Estate", EQIX: "Real Estate", WELL: "Real Estate",
  LIN: "Materials", SHW: "Materials", FCX: "Materials", ECL: "Materials",
};

function sectorLeaders(board: AnyRow[]) {
  const leaders = new Map<string, AnyRow>();
  for (const row of board) {
    if (!row.catalyst) continue;
    const sector = TICKER_SECTOR[row.ticker];
    if (!sector) continue;
    if (!leaders.has(sector)) leaders.set(sector, row);
  }
  return leaders;
}

function fmt(v: any) {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 16);
  return String(v);
}

function scoreColor(confidence: string) {
  if (confidence === "strong") return "#137333";
  if (confidence === "notable") return "#b06000";
  return "#5f6368";
}

export default async function Page() {
  const { scans, latestScan, board, shortlist, trades } = await getData();
  const openTrades = trades.filter((t) => t.status === "open");
  const newToday = shortlist.filter((s) => s.is_new).length;
  const leaders = sectorLeaders(board);
  const emptySectors = GICS_SECTORS.filter((s) => !leaders.has(s));

  return (
    <main className="page">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f6f8fb; }
        .page { max-width: 860px; margin: 0 auto; padding: 16px; font-family: system-ui, -apple-system, sans-serif; color: #202124; }
        .page h1 { font-size: 26px; margin: 8px 0 4px; }
        .subtitle { color: #5f6368; font-size: 14px; margin: 0 0 16px; line-height: 1.5; }
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
        .meta { color: #5f6368; font-size: 13px; margin-top: 4px; line-height: 1.45; }
        .detail { font-size: 14px; margin-top: 6px; line-height: 1.5; }
        .footer { color: #5f6368; font-size: 13px; margin: 24px 0 8px; text-align: center; }
        @media (min-width: 700px) {
          .page { padding: 24px; }
          .page h1 { font-size: 30px; }
          .status-grid { grid-template-columns: repeat(3, 1fr); }
          .cards { display: grid; grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <h1>SPY Scanner</h1>
      <p className="subtitle">
        Potential 5%+ rise within 1 week · Scans every 15 minutes, 24/7 · Daily catalyst shortlist · Paper trades $100 each, sell at +5% / −3%
      </p>

      <div className="status-grid">
        {[
          ["Latest scan", latestScan ? `${fmt(latestScan.scanned_at)} · ${latestScan.market_status}` : "No scans yet"],
          ["Leaderboard rows", String(board.length)],
          ["Daily shortlist", shortlist.length ? `${shortlist.length} tickers · ${newToday} new · ${fmt(shortlist[0].created_at)}` : "No shortlist yet"],
          ["Paper trades open", String(openTrades.length)],
          ["Sector leaders", `${leaders.size} of 11 sectors`],
          ["Scans shown", String(scans.length ? `${scans.length} (latest 10)` : "0")],
        ].map(([label, value]) => (
          <div key={label} className="status-card">
            <div className="status-label">{label}</div>
            <div className="status-value">{value}</div>
          </div>
        ))}
      </div>

      <section className="section">
        <h2>Ask about the scanner</h2>
        <p className="section-note">
          Ask why a ticker ranks where it does, why a trade was bought or skipped, or why a position closed. Answers use only today&apos;s board, shortlist and trades, via OpenRouter&apos;s free model — screening only, not financial advice.
        </p>
        <ChatBox />
      </section>

      <section className="section">
        <h2>Leaderboard — latest scan</h2>
        <p className="section-note">Ranked by score. A ticker only appears here with a named catalyst and reasoning — no catalyst, no row.</p>
        {board.length === 0 ? (
          <p>No candidates in the latest scan. A scan with no verified catalyst produces no rows, rather than invented picks.</p>
        ) : (
          <div className="cards">
            {board.map((r: any) => (
              <div key={r.ticker} className="row-card">
                <div className="row-top">
                  <div>
                    <div className="ticker">#{r.rank} {r.ticker}</div>
                    <div className="company">{r.company ?? ""}</div>
                  </div>
                  <div className="badge" style={{ color: scoreColor(r.confidence) }}>{r.score} · {r.confidence}</div>
                </div>
                <div className="price">${r.price ?? "—"}</div>
                <div className="meta">1d {r.change_1d_pct ?? "—"}% · 5d {r.change_5d_pct ?? "—"} · Sentiment: {r.sentiment ?? "—"}</div>
                <div className="detail">{r.catalyst ?? "—"}</div>
                <div className="meta">{r.reasoning}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Sector leaders</h2>
        <p className="section-note">
          Best catalyst-backed ticker per GICS sector. {leaders.size} of 11 sectors covered this scan.
          {emptySectors.length > 0 ? ` No leader for: ${emptySectors.join(", ")} — those sectors had no catalyst-backed ticker, so nothing is invented to fill them.` : ""}
        </p>
        {leaders.size === 0 ? (
          <p>No sector leaders in the latest scan.</p>
        ) : (
          <div className="cards">
            {GICS_SECTORS.filter((s) => leaders.has(s)).map((sector) => {
              const r: any = leaders.get(sector);
              return (
                <div key={sector} className="row-card">
                  <div className="row-top">
                    <div>
                      <div className="ticker">{r.ticker}</div>
                      <div className="company">{sector} · {r.company ?? ""}</div>
                    </div>
                    <div className="badge" style={{ color: scoreColor(r.confidence) }}>{r.score} · {r.confidence}</div>
                  </div>
                  <div className="price">${r.price ?? "—"}</div>
                  <div className="detail">{r.catalyst ?? "—"}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Daily catalyst shortlist</h2>
        <p className="section-note">The only universe the 15-minute scan covers. Rebuilt daily by /api/weekly: earnings plus each company&apos;s own guidance, product or regulatory news.</p>
        {shortlist.length === 0 ? (
          <p>No shortlist yet.</p>
        ) : (
          <div className="cards">
            {shortlist.map((s: any) => (
              <div key={s.ticker} className="row-card">
                <div className="row-top">
                  <div>
                    <div className="ticker">{s.ticker} {s.is_new ? "🆕" : ""}</div>
                    <div className="company">{s.company ?? ""}</div>
                  </div>
                  <div className="badge">{s.score}</div>
                </div>
                <div className="meta">{s.catalyst_type} · Event: {s.event_date ? fmt(s.event_date) : "—"}</div>
                <div className="detail">{s.event_detail ?? ""}</div>
                <div className="meta">{s.reasoning}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Paper trades — Alpaca paper only</h2>
        <p className="section-note">Daily /api/trade/daily buys one unique leaderboard stock per day, $100 each. /api/trade/check closes at +5% or −3%.</p>
        {trades.length === 0 ? (
          <p>No paper trades yet.</p>
        ) : (
          <div className="cards">
            {trades.map((t: any, i: number) => (
              <div key={`${t.ticker}-${i}`} className="row-card">
                <div className="row-top">
                  <div>
                    <div className="ticker">{t.ticker}</div>
                    <div className="company">Week of {fmt(t.week_start)} · Rank {t.leaderboard_rank ?? "—"}</div>
                  </div>
                  <div className="badge">{t.status}</div>
                </div>
                <div className="meta">Entry {t.entry_price ?? "—"} (${t.notional_usd}) · Exit {t.exit_price ?? "—"} · P&amp;L {t.pnl_pct ?? "—"}</div>
                <div className="meta">Opened {fmt(t.opened_at)}{t.closed_at ? ` · Closed ${fmt(t.closed_at)}` : ""}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>Recent scans</h2>
        {scans.length === 0 ? (
          <p>No scans recorded yet.</p>
        ) : (
          <div className="cards">
            {scans.map((s: any) => (
              <div key={s.id} className="row-card">
                <div className="ticker" style={{ fontSize: 15 }}>{fmt(s.scanned_at)}</div>
                <div className="meta">{s.market_status} · {s.universe}{s.notes ? ` · ${s.notes}` : ""}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="footer">Screening only, not financial advice. Scores are not a guarantee of a 5% rise.</p>
    </main>
  );
}
