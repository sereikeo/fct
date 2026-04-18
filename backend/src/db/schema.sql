CREATE TABLE IF NOT EXISTS budget_items (
  id              TEXT PRIMARY KEY,
  notion_page_id  TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT,
  type            TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  frequency       TEXT NOT NULL CHECK (frequency IN ('once', 'weekly', 'fortnightly', 'monthly', 'annual')),
  due_date        TEXT NOT NULL,
  is_variable     INTEGER NOT NULL DEFAULT 0,
  bucket          TEXT NOT NULL CHECK (bucket IN ('personal', 'maple')),
  payment         TEXT NOT NULL,
  forecast_amount REAL NOT NULL,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS envelope_overrides (
  id              TEXT PRIMARY KEY,
  budget_item_id  TEXT NOT NULL REFERENCES budget_items(id),
  period          TEXT NOT NULL,
  override_amount REAL NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (budget_item_id, period)
);

CREATE TABLE IF NOT EXISTS reconciliation (
  id              TEXT PRIMARY KEY,
  budget_item_id  TEXT NOT NULL REFERENCES budget_items(id),
  date            TEXT NOT NULL,
  forecast_amount REAL NOT NULL,
  actual_amount   REAL NOT NULL,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
