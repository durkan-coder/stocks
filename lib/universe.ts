// Staggered-500 universe: live FMP list first (it tracks index
// changes), then the static SPY list in lib/sp500.ts (public tickers,
// no API call, no key to break), then the small cached fallback in
// lib/feed.ts. Order matters: FMP recovering automatically upgrades
// the universe; the static list guarantees the staggered jobs still
// cover ~500 names while FMP is 401.
import { getSp500Constituents, type Constituent } from "@/lib/feed";
import { SP500_UNIVERSE } from "@/lib/sp500";

export async function getUniverse(): Promise<{ list: Constituent[]; source: string }> {
  const fmp = await getSp500Constituents();
  if (fmp.source === "fmp" && fmp.list.length > 50) {
    return { list: fmp.list, source: "fmp" };
  }
  if (SP500_UNIVERSE.length > 50) {
    return { list: SP500_UNIVERSE, source: "static" };
  }
  return { list: fmp.list, source: fmp.source };
}

export function sliceUniverse<T>(list: T[], slice: number, size = 50): T[] {
  const slices = Math.max(1, Math.ceil(list.length / size));
  const s = ((slice % slices) + slices) % slices;
  return list.slice(s * size, s * size + size);
}

export function sliceCount(listLength: number, size = 50): number {
  return Math.max(1, Math.ceil(listLength / size));
}
