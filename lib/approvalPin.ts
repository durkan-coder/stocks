import { timingSafeEqual } from "crypto";

// Approval PIN for human-in-the-loop trades.
//
// The PIN itself is NEVER in this repo, NEVER in chat, and NEVER
// logged. It lives only as the Vercel environment variable
// APPROVAL_PIN, set by the user in the Vercel dashboard (and a
// redeploy after setting it, since env changes need a new
// deployment to take effect).
//
// Fail closed: if APPROVAL_PIN is not set, every PIN check fails
// and approve / reject / settings changes are blocked. That is
// deliberate — an unset PIN must not silently mean "open".
// This also doubles as CSRF protection: a malicious page cannot
// submit these forms without knowing the PIN.
//
// Do NOT reuse CRON_SECRET as the PIN. The PIN is typed in the
// browser on the home screen; the cron secret is sent only by
// cron-job.org. Keeping them separate limits the blast radius
// if either one leaks.
export function pinConfigured(): boolean {
  return Boolean(process.env.APPROVAL_PIN);
}

export function isPinValid(pin: string | null | undefined): boolean {
  const expected = process.env.APPROVAL_PIN;
  if (!expected || !pin) return false;
  const a = Buffer.from(pin);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
