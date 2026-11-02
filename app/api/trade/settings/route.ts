import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { isPinValid } from "@/lib/approvalPin";

// Toggle human approval for daily buys. 'on' (default): the daily
// run creates a proposal and buys nothing until the user approves
// it in the portfolio home. 'off': the daily run buys directly as
// before. Sells are unaffected either way — /api/trade/check
// still closes at +3% / -2% automatically. Paper only; this is a
// personal-use toggle, not an authenticated admin setting, and
// it cannot place a trade by itself.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let value = "";
  let pin: string | null = null;
  try {
    const form = await req.formData();
    value = String(form.get("value") ?? "");
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      value = String(body.value ?? "");
      pin = body.pin ? String(body.pin) : null;
    } catch {
      value = "";
    }
  }
  const homeWith = (notice: string) => {
    const u = new URL("/", req.url);
    u.searchParams.set("notice", notice);
    return NextResponse.redirect(u);
  };
  if (!isPinValid(pin)) return homeWith("pin_invalid");
  if (value !== "on" && value !== "off") return homeWith("settings_invalid");
  await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`
    INSERT INTO trade_settings (key, value, updated_at) VALUES ('human_approval', ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  return homeWith(value === "on" ? "settings_on" : "settings_off");
}
