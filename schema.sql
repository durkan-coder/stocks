-- SPY / S&P 500 scanner leaderboard — Vercel Postgres schema
-- Runs every 15 minutes, 24/7. Horizon: potential 5%+ rise within 1 week.
-- Each scan is a snapshot; history is kept so hit-rate can be measured.

CREATE TABLE IF NOT EXISTS scans (
  id SERIAL PRIMARY KEY,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_status TEXT NOT NULL, -- 'open', 'pre_market', 'after_hours', 'closed', 'holiday'
  universe TEXT NOT NULL DEFAULT 'SPY constituents (S&P 500)',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS leaderboard (
  id SERIAL PRIMARY KEY,
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  scanned_at TIMESTAMPTZ NOT NULL,
  rank INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  company TEXT,
  price NUMERIC,
  change_1d_pct NUMERIC,
  change_5d_pct NUMERIC,
  volume_ratio NUMERIC, -- today's / recent average volume
  score NUMERIC NOT NULL, -- 0-100 composite
  catalyst TEXT, -- earnings, analyst, news, sector, macro, sentiment, technical
  sentiment TEXT, -- positive / mixed / negative, with source summary
  reasoning TEXT NOT NULL, -- why this could rise 5%+ within 1 week
  sources TEXT, -- comma-separated source names/URLs
  confidence TEXT NOT NULL DEFAULT 'watch', -- watch / notable / strong
  target_pct NUMERIC NOT NULL DEFAULT 5.0
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_scanned_at ON leaderboard(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_ticker ON leaderboard(ticker, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_scans_scanned_at ON scans(scanned_at DESC);

-- Latest board for the frontend: latest scan only
-- SELECT * FROM leaderboard WHERE scan_id = (SELECT MAX(id) FROM scans) ORDER BY rank;
