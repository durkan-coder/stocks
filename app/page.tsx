// Simple leaderboard page. Fetches /api/leaderboard on load and refreshes
// every 60 seconds; new scans land every 15 minutes via cron-job.org.
async function getBoard() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  const res = await fetch(`${base}/api/leaderboard`, { cache: "no-store" });
  if (!res.ok) return { scan: null, rows: [] };
  return res.json();
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
