import { neon } from "@neondatabase/serverless";
import { NextRequest, NextResponse } from "next/server";
import { isPinValid } from "@/lib/approvalPin";
import { sweepTaxReserve } from "@/lib/taxPark";

// Park the tax reserve now: sweep whatever tax is owed on this
// year's realized gains but not yet parked into SGOV (money market
// ETF) as a real Alpaca paper buy — the same buy pattern as a stock
// buy. PIN-gated like a sell, because it places a real order.
// Used for the one-tap catch-up after the MRNA sale, and for small
// slices that only reach $1 in total later. Redirects home with a
// visible result banner like approve/reject/sell.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sql = neon(process.env.DATABASE_URL!);
  let pin: string | null = null;
  try {
    const form = await req.formData();
    pin = form.get("pin") ? String(form.get("pin")) : null;
  } catch {
    try {
      const body = await req.json();
      pin = body.pin ? String(body.pin) : null;
    } catch {
      pin = null;
    }
  }
  const homeWith = (notice: string) => {
    const u = new URL("/", req.url);
    u.searchParams.set("notice", notice);
    return NextResponse.redirect(u);
  };
  if (!isPinValid(pin)) {
    return homeWith("pin_invalid");
  }
  let result;
  try {
    result = await sweepTaxReserve(sql);
  } catch {
    return homeWith("tax_park_failed");
  }
  if (result.reason === "parked") return homeWith("tax_parked");
  if (result.reason === "nothing_owed" || result.reason === "below_minimum") return homeWith("tax_park_nothing");
  return homeWith("tax_park_failed");
}
