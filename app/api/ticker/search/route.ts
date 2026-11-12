import { NextRequest, NextResponse } from "next/server";
import { getUniverse } from "@/lib/universe";

// Ticker search for the ad-hoc buy form: type a company name (or
// the start of a ticker) and get matching symbols back, so the
// user never has to remember a ticker. Read-only, public — it
// only returns ticker + company names from the SPY universe (live
// FMP constituents first, static 503 fallback), the same list the
// scanner itself uses. Names outside SPY are not in this list;
// the buy form still accepts any typed ticker directly.
//
// Matching: exact ticker first, then ticker prefix, then company
// name contains (case-insensitive), up to 8 results. The universe
// list is cached in memory for 5 minutes so typing does not hit
// FMP on every keystroke.
export const dynamic = "force-dynamic";

let cached: { at: number; list: Array<{ ticker: string; company: string }> } | null = null;

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const needle = q.toUpperCase();
  const needleLower = q.toLowerCase();

  let list = cached && Date.now() - cached.at < 5 * 60 * 1000 ? cached.list : null;
  if (!list) {
    try {
      const universe = await getUniverse();
      list = universe.list.map((c) => ({ ticker: String(c.ticker).toUpperCase(), company: String(c.company ?? "") }));
      cached = { at: Date.now(), list };
    } catch {
      return NextResponse.json({ results: [] });
    }
  }

  const scored: Array<{ ticker: string; company: string; rank: number }> = [];
  for (const c of list) {
    if (!c.ticker) continue;
    if (c.ticker === needle) scored.push({ ...c, rank: 0 });
    else if (c.ticker.startsWith(needle)) scored.push({ ...c, rank: 1 });
    else if (c.company && c.company.toLowerCase().includes(needleLower)) scored.push({ ...c, rank: 2 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.ticker.localeCompare(b.ticker));
  return NextResponse.json({ results: scored.slice(0, 8).map(({ ticker, company }) => ({ ticker, company })) });
}
