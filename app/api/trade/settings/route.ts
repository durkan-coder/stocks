import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { isPinValid } from "@/lib/approvalPin";

// Toggles for trade behaviour, set from the portfolio home.
// Keys:
//  - 'human_approval' ('on' default): the daily run creates a
//    proposal and buys nothing until the user approves it.
//    'off': the daily run buys directly as before.
//  - 'auto_sell' ('off' default since 2026-11-09, manual only):
//    'on' re-enables /api/trade/check closing positions at
//    +3% / -2% automatically; 'off' makes the check watch-only
//    (it records threshold crossings in sell_alerts and sells
//    nothing — the user sells from the home page instead).
//  - 'daily_buy_count' ('1' default): how many never-bought
//    tickers the daily run proposes (or buys, if approval is off)
//    each day, in rank order, $100 each. Integer 1-5; set on the
//    portfolio home (PIN-gated). Added 2026-11-10, Durkan: buy
//    multiple stocks in a day.
// Paper only; these are personal-use toggles, not authenticated
// admin settings, and they cannot place a trade by themselves.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let key = "human_approval";
  let value = "";
  let pin: string | null = null;
  try {
    const form = await req.formData();
    key = String(form.get("key") ?? "human_approval");
    value = String(form.get("value") ?? "");
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      key = String(body.key ?? "human_approval");
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
  if (key === "daily_buy_count") {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 5) return homeWith("settings_invalid");
    await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`
      INSERT INTO trade_settings (key, value, updated_at) VALUES (${key}, ${String(n)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    return homeWith("settings_daily_count");
  }
  if (key !== "human_approval" && key !== "auto_sell") return homeWith("settings_invalid");
  if (value !== "on" && value !== "off") return homeWith("settings_invalid");
  await sql`CREATE TABLE IF NOT EXISTS trade_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  await sql`
    INSERT INTO trade_settings (key, value, updated_at) VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  if (key === "auto_sell") {
    return homeWith(value === "on" ? "settings_auto_sell_on" : "settings_auto_sell_off");
  }
  return homeWith(value === "on" ? "settings_on" : "settings_off");
}
