import { NextRequest } from "next/server";
import { runMoversSweep } from "@/lib/movers";

// Daily missed-movers sweep — run ONCE a day AFTER the close
// (cron-job.org, 13:15 PT / 16:15 ET, POST /api/movers/daily,
// same CRON_SECRET header as the other jobs). Captures the close.
// The shared logic lives in lib/movers.ts; /api/movers/midday
// runs the same sweep at ~11:00 PT for intraday moves.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return runMoversSweep(req, "daily");
}

export async function GET(req: NextRequest) {
  return POST(req);
}
