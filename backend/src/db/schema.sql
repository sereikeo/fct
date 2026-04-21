CREATE TABLE IF NOT EXISTS budget_items (
  id              TEXT PRIMARY KEY,
  notion_page_id  TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT,
  type            TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  frequency       TEXT CHECK (frequency IN ('once', 'weekly', 'fortnightly', 'monthly', 'annual')),
  recur_interval  INTEGER NOT NULL DEFAULT 1,
  due_date        TEXT NULL,
  is_variable     INTEGER NOT NULL DEFAULT 0,
  is_envelope     INTEGER NOT NULL DEFAULT 0,
  bucket          TEXT NOT NULL CHECK (bucket IN ('personal', 'maple')),
  payment         TEXT NOT NULL,
  forecast_amount REAL NOT NULL,
  status          TEXT NOT NULL DEFAULT 'not started',
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_items_notion_page_id
  ON budget_items (notion_page_id);

CREATE TABLE IF NOT EXISTS envelope_overrides (
  id              TEXT PRIMARY KEY,
  budget_item_id  TEXT NOT NULL REFERENCES budget_items(id),
  period          TEXT NOT NULL,
  override_amount REAL NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_envelope_overrides_item_period
  ON envelope_overrides (budget_item_id, period);

CREATE TABLE IF NOT EXISTS reconciliation (
  id              TEXT PRIMARY KEY,
  budget_item_id  TEXT NOT NULL REFERENCES budget_items(id),
  date            TEXT NOT NULL,
  forecast_amount REAL NOT NULL,
  actual_amount   REAL NOT NULL,
  note            TEXT,
  delta           REAL GENERATED ALWAYS AS (actual_amount - forecast_amount) STORED,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_budget_item_id
  ON reconciliation (budget_item_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                TEXT PRIMARY KEY,
  notion_page_id    TEXT NOT NULL,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL,
  bucket            TEXT NOT NULL,
  frequency         TEXT,
  recur_interval    INTEGER,
  expected_date     TEXT,
  amount            REAL NOT NULL,
  confirmed         INTEGER NOT NULL DEFAULT 0,
  confirmed_date    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_notion_page_id
  ON transactions (notion_page_id);

CREATE TABLE IF NOT EXISTS spend_log (
  id              TEXT PRIMARY KEY,
  budget_item_id  TEXT NOT NULL REFERENCES budget_items(id),
  tx_id           TEXT REFERENCES transactions(id),
  date            TEXT NOT NULL,
  amount          REAL NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spend_log_budget_item_id
  ON spend_log (budget_item_id);

CREATE INDEX IF NOT EXISTS idx_spend_log_tx_id
  ON spend_log (tx_id);
