# Deploy to Vercel + test — ronik7/stocks

Project dashboard: https://vercel.com/ronik7/stocks
Trigger: cron-job.org (free tier — no Vercel Cron)

## Step 0 — What you are deploying

Copy the contents of this `vercel-app/` folder to the ROOT of your
project's Git repo (not into a subfolder), so Vercel sees:
`package.json`, `tsconfig.json`, `app/`, `lib/` at the top level.
If your existing `stocks` project already has its own code, tell me
what's in it first — don't overwrite it blindly.

Files to copy:
- package.json, tsconfig.json, .gitignore
- app/layout.tsx, app/page.tsx
- app/api/scan/route.ts, app/api/leaderboard/route.ts, app/api/weekly/route.ts
- lib/scan.ts, lib/weekly.ts

## Step 1 — Create the tables in Neon (once)

In Vercel: Project > Storage > your Neon database > open the SQL editor
(or Neon console > SQL Editor). Run, in order:
1. `../schema.sql` — scans + leaderboard tables
2. `../weekly_shortlist.sql` — catalyst shortlist table

Verify:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public';
```
You should see `scans`, `leaderboard`, `weekly_shortlist`.

## Step 2 — Environment variables in Vercel

Project > Settings > Environment Variables:
- `DATABASE_URL` — should ALREADY be there from the Neon integration.
  If it is, do nothing. Never paste it in chat.
- `CRON_SECRET` — add it yourself. Generate one, e.g. on your machine:
  `openssl rand -hex 32`
  Use the same value in cron-job.org later. Keep it private.

After adding/changing env vars, redeploy (Deployments > ... > Redeploy),
because serverless functions only pick up new env vars on a fresh deploy.

## Step 3 — Deploy

If the repo is connected to Vercel (the usual case):
```bash
git add .
git commit -m "Add SPY scanner: leaderboard, scan, weekly shortlist"
git push
```
Vercel auto-deploys. Wait for the deployment to show "Ready".

Find your PUBLIC app URL (not the dashboard URL):
Vercel > Deployments > click the latest deployment > Domains.
It looks like `https://stocks-xxxx.vercel.app`.
Call it APP_URL below.

## Step 4 — Test, in this order (before cron-job.org)

1. Homepage (no auth needed):
   `APP_URL/` — should show "No scans yet" at first. That is expected.

2. Leaderboard API (no auth needed):
   `APP_URL/api/leaderboard`
   Expected at first: `{"scan": null, "rows": []}`

3. Auth check (should FAIL without the secret — this is good):
   `curl -X POST APP_URL/api/scan`
   Expected: `{"error": "unauthorized"}` (401)

4. Shortlist trigger (with secret):
   `curl -X POST APP_URL/api/weekly -H "Authorization: Bearer YOUR_CRON_SECRET"`
   Expected: `{"ok": true, "tickers": 0, "newTickers": []}` for now —
   see the honest note below.

5. Scan trigger (with secret):
   `curl -X POST APP_URL/api/scan -H "Authorization: Bearer YOUR_CRON_SECRET"`
   Expected: `{"ok": true, "mode": "shortlist", "universeTickers": 0, "rows": 0}`
   Then re-check `/api/leaderboard` — it should now show a scan row,
   still with 0 leaderboard rows.

6. Check Neon:
   ```sql
   SELECT id, scanned_at, market_status, universe, notes FROM scans ORDER BY id DESC LIMIT 5;
   ```
   You should see the scan you just triggered.

If step 3 does NOT return 401, CRON_SECRET is not set — fix it before
going live, or anyone can trigger scans against your database.

## Step 5 — Turn on cron-job.org

Only after steps 1-4 pass. See README-cron-job.md:
- Daily job: `APP_URL/api/weekly`, pre-market ET
- Every 15 min, 24/7: `APP_URL/api/scan`
- Both: POST, header `Authorization: Bearer YOUR_CRON_SECRET`
- Then watch cron-job.org job history for 200 responses, and Vercel >
  Logs for errors.

## Honest note: what "test passes" means right now

A passing deploy test proves: Vercel builds, Neon connects, auth works,
scans are recorded, and the leaderboard API serves data.
It does NOT yet produce real stock picks — the quote/news data layer
in `app/api/scan/route.ts` and `app/api/weekly/route.ts` is still a
placeholder that deliberately writes no fake rows. That is the next
step after deployment: wire a real earnings-calendar + news + quote
feed into those two routes, then the first real shortlist will appear.
