// Simple leaderboard page. Queries Neon directly instead of fetching
// /api/leaderboard: a relative fetch fails on the server with
// "Failed to parse URL from /api/leaderboard" unless a base URL env var
// is set, which is why the homepage 500s even apart from missing tables.
// New scans land every 15 minutes via cron-job.org.
import { neon } from "@neondatabase/serverless";

async function getBoard() {
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const scans = await sql`SELECT id, scanned_at, market_status FROM scans ORDER BY id DESC LIMIT 1`;
    if (scans.length === 0) return { scan: null, rows: [] };
    const scan = scans[0];
    const rows = await sql`
      SELECT rank, ticker, company, price, change_1d_pct, change_5d_pct,
             volume_ratio, score, catalyst, sentiment, reasoning, sources,
             confidence, target_pct, scanned_at
      FROM leaderboard
      WHERE scan_id = ${scan.id}
      ORDER BY rank ASC
    `;
    return { scan, rows };
  } catch {
    return { scan: null, rows: [] };
  }
}

export default async function Page() {
  const { scan, rows } = await getBoard();
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "system-ui" }}>
      <h1>SPY Scanner Leaderboard</h1>
      <p>
        Potential 5%+ rise within 1 week · Updated every 15 minutes, 24/7 ·{" "}
        {scan ? `Last scan: ${scan.scanned_at} (${scan.market_status})` : "No scans yet"}
      </p>
      {rows.length === 0 ? (
        <p>No candidates in the latest scan. A scan with no verified catalyst produces no rows, rather than invented picks.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">#</th>
              <th align="left">Ticker</th>
              <th align="left">Score</th>
              <th align="left">Price</th>
              <th align="left">Catalyst</th>
              <th align="left">Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.ticker} style={{ borderTop: "1px solid #ddd" }}>
                <td>{r.rank}</td>
                <td><strong>{r.ticker}</strong></td>
                <td>{r.score} ({r.confidence})</td>
                <td>{r.price ?? "—"}</td>
                <td>{r.catalyst ?? "—"}</td>
                <td>{r.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: "#666" }}>
        Screening only, not financial advice. Scores are not a guarantee of a 5% rise.
      </p>
    </main>
  );
}
