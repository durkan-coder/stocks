// Missed-movers review page — the daily >=5% sweep, kept in
// Postgres (missed_movers, 30 days) and reviewed weekly by hand.
// Every SPY name that moved 5% or more in a day, with whether the
// scanner had it on the board and the reason for the move. The
// weekly review is manual by design: Durkan reads this page,
// spots the pattern in what was missed (a catalyst type, a sector,
// a timing gap), and tells Muse what logic to adjust — no
// automatic reweighting, no silent threshold changes. The sweep
// itself runs twice a day — midday (11:00 PT, /api/movers/midday)
// and after the close (13:15 PT, /api/movers/daily); this page
// only reads what they wrote.
import { neon } from "@neondatabase/serverless";
import Tabs from "../components/Tabs";

export const dynamic = "force-dynamic";

type AnyRow = Record<string, any>;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function fmtDay(v: any) {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || "—";
  const d = new Date(`${s}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = searchParams ? await searchParams : {};
  const showRaw = Array.isArray(sp.show) ? sp.show[0] : sp.show;
  const showMissedOnly = showRaw !== "all";

  const sql = neon(process.env.DATABASE_URL!);
  const rows = await safe(
    () =>
      sql`
        SELECT mover_date, ticker, company, move_pct, direction, missed, reason, sources
        FROM missed_movers
        ORDER BY mover_date DESC, ABS(move_pct) DESC, ticker ASC
        LIMIT 500
      `,
    [] as AnyRow[],
  );

  // Group by date, latest first.
  const byDate = new Map<string, AnyRow[]>();
  for (const r of rows) {
    const d = String(r.mover_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(r);
  }
  const dates = [...byDate.keys()].sort().reverse();

  // Last 7 days: the weekly-review summary.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const weekRows = rows.filter((r) => String(r.mover_date).slice(0, 10) >= cutoffStr);
  const weekMissed = weekRows.filter((r) => r.missed);
  const weekMissedPct = weekRows.length > 0 ? Math.round((weekMissed.length / weekRows.length) * 100) : null;

  const visibleDates = dates.map((d) => {
    const dayRows = byDate.get(d)!;
    const shown = showMissedOnly ? dayRows.filter((r) => r.missed) : dayRows;
    return { date: d, dayRows, shown };
  });

  return (
    <main className="page">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f6f8fb; }
        .page { max-width: 860px; margin: 0 auto; padding: 16px; font-family: system-ui, -apple-system, sans-serif; color: #202124; }
        .page h1 { font-size: 26px; margin: 8px 0 4px; }
        .back { font-size: 14px; }
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
        .meta { color: #5f6368; font-size: 13px; margin-top: 4px; line-height: 1.45; }
        .footer { color: #5f6368; font-size: 13px; margin: 24px 0 8px; text-align: center; }
        .toggle { font-size: 14px; margin: 12px 0 0; }
        @media (min-width: 700px) {
          .page { padding: 24px; }
          .page h1 { font-size: 30px; }
          .status-grid { grid-template-columns: repeat(3, 1fr); }
        }
      `}</style>
      <p className="back"><a href="/scanner">← Scanner</a> · <a href="/">Portfolio</a></p>
      <h1>Missed movers — ≥5% a day</h1>
      <p className="subtitle">
        Every SPY name that moved 5% or more in a day, from the midday (11:00 PT) and after-close (13:15 PT) sweeps. Kept in Postgres for 30 days. Review weekly, adjust the logic by hand.
      </p>
      <Tabs
        tabs={[
          { id: "positions", label: "Positions", icon: "📈", href: "/" },
          { id: "scanner", label: "Scanner", icon: "📊", href: "/scanner" },
          { id: "journal", label: "Journal", icon: "📓", href: "/journal" },
        ]}
      />
      <div className="status-grid" style={{ marginTop: 16 }}>
        <div className="status-card">
          <div className="status-label">Last 7 days — big movers</div>
          <div className="status-value">{weekRows.length ? `${weekRows.length} movers` : "No runs yet"}</div>
        </div>
        <div className="status-card">
          <div className="status-label">Last 7 days — missed by us</div>
          <div className="status-value">{weekRows.length ? `${weekMissed.length} missed (${weekMissedPct}% of movers)` : "No runs yet"}</div>
        </div>
        <div className="status-card">
          <div className="status-label">Days on file</div>
          <div className="status-value">{dates.length ? `${dates.length} day${dates.length === 1 ? "" : "s"} · ${fmtDay(dates[dates.length - 1])} → ${fmtDay(dates[0])}` : "No runs yet"}</div>
        </div>
      </div>
      <p className="toggle">
        {showMissedOnly ? (
          <>Showing <strong>missed only</strong> — the names the scanner never saw. <a href="/movers?show=all">Show all movers</a></>
        ) : (
          <>Showing <strong>all movers</strong>, missed and on-board. <a href="/movers">Show missed only</a></>
        )}
      </p>
      {rows.length === 0 ? (
        <section className="section">
          <h2>No runs yet</h2>
          <p className="section-note">The sweeps run twice a day — midday (11:00 PT, cron-job.org → POST /api/movers/midday) and after the close (13:15 PT, cron-job.org → POST /api/movers/daily). Until the first run this page stays honestly empty — the first rows appear the morning after the first run.</p>
        </section>
      ) : (
        visibleDates.map(({ date, dayRows, shown }) => {
          const missedCount = dayRows.filter((r) => r.missed).length;
          return (
            <section className="section" key={date}>
              <h2>{fmtDay(date)}</h2>
              <p className="section-note">{dayRows.length} mover{dayRows.length === 1 ? "" : "s"} ≥5% · {missedCount} missed by us · {dayRows.length - missedCount} on board</p>
              {shown.length === 0 ? (
                <p className="meta">Nothing missed that day — every ≥5% mover was on the board.</p>
              ) : (
                <div className="cards">
                  {shown.map((m: AnyRow, i: number) => {
                    const pct = Number(m.move_pct);
                    const up = pct >= 0;
                    return (
                      <div key={`${m.ticker}-${date}-${i}`} className="row-card">
                        <div className="row-top">
                          <div>
                            <div className="ticker">{m.ticker}</div>
                            <div className="company">{m.company ?? ""}</div>
                          </div>
                          <div style={{ fontWeight: 800, color: up ? "#137333" : "#a50e0e" }}>{up ? "+" : ""}{pct.toFixed(2)}%</div>
                        </div>
                        <div className="meta">{m.missed ? "⚠️ Missed by us" : "✓ On board"}</div>
                        <div className="meta">{m.reason ?? ""}</div>
                        {m.sources ? <div className="meta">Source: {m.sources}</div> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })
      )}
      <p className="footer">Screening only, not financial advice. Reasons are quoted headlines and earnings dates, never invented.</p>
    </main>
  );
}
