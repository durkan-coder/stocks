import { NextRequest } from "next/server";
import { runMoversSweep } from "@/lib/movers";

// Midday missed-movers sweep — run ONCE a day MIDDAY
// (cron-job.org, 11:00 PT / 14:00 ET, POST /api/movers/midday,
// same CRON_SECRET header as the other jobs). Same logic as
// /api/movers/daily (lib/movers.ts): every SPY name whose 1-day
// move is >= 5% in either direction, with the missed flag and a
// quoted reason. The point is intraday capture — the Nov 12
// alerts (MRNA -5.17%, UAL -5.10% at ~11:00 PT, GPN -10.40%
// at ~9:45 PT) were midday prints that the after-close sweep
// would miss if they recovered by the close. Both sweeps write
// the same missed_movers rows (one per date+ticker); the
// after-close run overwrites them with the close values, and a
// name that recovers below 5% by the close keeps its midday row.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return runMoversSweep(req, "midday");
}

export async function GET(req: NextRequest) {
  return POST(req);
}
