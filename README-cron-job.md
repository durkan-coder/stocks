# Wiring cron-job.org -> Vercel (free tier)

Project: ronik7/stocks — https://vercel.com/ronik7/stocks

## 1. In Vercel
- Run `schema.sql` (in stock-scanner/) against your Neon database once.
  Use the Neon SQL editor or Vercel Storage tab — do not paste DATABASE_URL in chat.
- Add env var `CRON_SECRET` = a long random value (Project > Settings > Environment Variables).
- Deploy this app. Note its public deployment URL, e.g.
  `https://stocks-XXXX.vercel.app` — do NOT guess it; copy it from Vercel.
  The dashboard URL https://vercel.com/ronik7/stocks is not the app URL.

## 2. In cron-job.org (https://console.cron-job.org/dashboard)
Create two jobs, both with header `Authorization: Bearer <your CRON_SECRET>`:

- Title: stocks-shortlist-daily
  - URL: `https://<your-deployment>.vercel.app/api/weekly`
  - Schedule: every day, e.g. pre-market ET — this rebuilds the top-50
    catalyst list daily and flags `is_new` tickers, so new additions
    are spotted the same day, not next week.
- Title: stocks-scan-15min
  - URL: `https://<your-deployment>.vercel.app/api/scan`
  - Schedule: every 15 minutes, all days (24/7)
  - Request method: POST (GET also works)
  - Timeout: leave default; the route is designed to stay fast.

## 3. Check it worked
- Open `https://<your-deployment>.vercel.app/api/leaderboard` — it should
  return the latest scan. The first scans may legitimately return 0 rows
  until the real quote/news data layer replaces the placeholder in
  `app/api/scan/route.ts`.
- Open the app homepage for the leaderboard table.

## Why this shape, and its limits
- Vercel free tier does not allow 15-minute Vercel Cron, so cron-job.org
  is the trigger. It only *triggers* — the work still runs in Vercel.
- Hobby serverless functions are time-limited, so a full 500-ticker LLM
  analysis in one call will time out. The production data layer must
  screen quantitatively first and reason only over the top ~10-15.
- When the market is closed, the scan labels market_status accordingly
  and must not invent intraday price movement.
