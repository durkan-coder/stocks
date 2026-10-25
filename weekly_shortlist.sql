-- Catalyst shortlist: stage 1 of the free-tier two-stage scan.
-- Rebuilt EVERY DAY (via cron-job.org, e.g. pre-market ET), not just weekly,
-- so a stock that gains a new catalyst is added promptly and flagged is_new.
-- The 15-minute scan then covers ONLY these ~50 tickers; the rest of the
-- S&P 500 is checked on demand, not every 15 minutes.

CREATE TABLE IF NOT EXISTS weekly_shortlist (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  ticker TEXT NOT NULL,
  company TEXT,
  catalyst_type TEXT NOT NULL, -- earnings, guidance, macro, geopolitical, sector, regulatory, product
  event_date DATE,
  event_detail TEXT,
  reasoning TEXT NOT NULL, -- why this could move 5%+ this week
  score NUMERIC NOT NULL, -- 0-100 weekly catalyst score
  sources TEXT,
  is_new BOOLEAN NOT NULL DEFAULT FALSE, -- not in the previous day's shortlist
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For databases created before the daily change:
ALTER TABLE weekly_shortlist ADD COLUMN IF NOT EXISTS is_new BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_weekly_week_ticker ON weekly_shortlist(week_start DESC, ticker);
CREATE INDEX IF NOT EXISTS idx_weekly_score ON weekly_shortlist(week_start DESC, score DESC);

-- Current shortlist for the 15-min scan (latest daily rebuild):
-- SELECT ticker FROM weekly_shortlist
-- WHERE DATE(created_at) = (SELECT MAX(DATE(created_at)) FROM weekly_shortlist)
-- ORDER BY score DESC LIMIT 50;
-- New additions today:
-- SELECT ticker FROM weekly_shortlist
-- WHERE DATE(created_at) = CURRENT_DATE AND is_new = TRUE ORDER BY score DESC;
