-- Alpaca PAPER trades. Run in Neon alongside schema.sql.
-- Paper only: $100 per stock, top 3 leaderboard stocks each week,
-- sell at +5% (take profit) or -3% (stop loss) from entry.

CREATE TABLE IF NOT EXISTS paper_trades (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL,
  ticker TEXT NOT NULL,
  leaderboard_rank INTEGER,
  entry_price NUMERIC,
  notional_usd NUMERIC NOT NULL DEFAULT 100,
  alpaca_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open, closed_take_profit, closed_stop_loss, closed_manual
  exit_price NUMERIC,
  pnl_pct NUMERIC,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker ON paper_trades(ticker, opened_at DESC);
