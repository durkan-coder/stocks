import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { isPinValid } from "@/lib/approvalPin";

// Reject a pending trade proposal: no order, no trade, and the
// ticker remains never-bought, so it can be proposed again on a
// later day if it still passes the guards then. A rejection is
// for today's proposal only — it is not a permanent blacklist.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let proposalId: number | null = null;
  let pin: string | null = null;
  try {
    const form = await req.formData();
    proposalId = Number(form.get("proposalId"));
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      proposalId = Number(body.proposalId);
      pin = body.pin ? String(body.pin) : null;
    } catch {
      proposalId = null;
    }
  }
  const home = new URL("/", req.url);
  if (!isPinValid(pin)) return NextResponse.redirect(home);
  if (!proposalId || !Number.isFinite(proposalId)) return NextResponse.redirect(home);
  const full = await sql`
    SELECT id, ticker, leaderboard_rank, status FROM trade_proposals WHERE id = ${proposalId} LIMIT 1
  `;
  if (full.length === 0 || full[0].status !== "pending") return NextResponse.redirect(home);
  await sql`UPDATE trade_proposals SET status = 'rejected', decided_at = NOW() WHERE id = ${proposalId}`;
  try {
    await sql`INSERT INTO trade_attempts (job, scan_id, ticker, leaderboard_rank, outcome, detail)
      VALUES ('trade_daily', null, ${full[0].ticker}, ${full[0].leaderboard_rank}, 'rejected_by_user', null)`;
  } catch { /* logging must not block */ }
  return NextResponse.redirect(home);
}
