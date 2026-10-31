import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";

// Toggle human approval for daily buys. 'on' (default): the daily
// run creates a proposal and buys nothing until the user approves
// it in the portfolio home. 'off': the daily run buys directly as
// before. Sells are unaffected either way — /api/trade/check
// still closes at +5% / -3% automatically. Paper only; this is a
// personal-use toggle, not an authenticated admin setting, and
// it cannot place a trade by itself.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let value = "";
  try {
    const form = await req.formData();
    value = String(form.get("value") ?? "");
  } catch {
    try {
      const body = await req.json();
      value = String(body.value ?? "");
    } catch {
      value = "";
    }
  }
  if (value !== "on" && value !== "off") return NextResponse.redirect(new URL("/", req.url));
  await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`
    INSERT INTO trade_settings (key, value, updated_at) VALUES ('human_approval', ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  return NextResponse.redirect(new URL("/", req.url));
}
