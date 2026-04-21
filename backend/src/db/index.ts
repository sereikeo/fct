import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), 'data', 'fct.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// Idempotent migrations for columns added after initial schema deployment.
// CREATE TABLE IF NOT EXISTS above is a no-op for existing tables, so new
// columns must be applied explicitly here.
// Idempotent migration: add recur_interval column if an older DB predates it.
// CREATE TABLE IF NOT EXISTS above is a no-op for existing tables, so schema
// changes to existing columns must be applied explicitly here.
const cols = db.pragma('table_info(budget_items)') as Array<{ name: string; notnull: 0 | 1 }>;
if (!cols.some(c => c.name === 'recur_interval')) {
  db.exec('ALTER TABLE budget_items ADD COLUMN recur_interval INTEGER NOT NULL DEFAULT 1');
}
if (!cols.some(c => c.name === 'status')) {
  db.exec("ALTER TABLE budget_items ADD COLUMN status TEXT NOT NULL DEFAULT 'not started'");
}
if (!cols.some(c => c.name === 'is_envelope')) {
  db.exec('ALTER TABLE budget_items ADD COLUMN is_envelope INTEGER NOT NULL DEFAULT 0');
}

// Once-off items have a null frequency. Older DBs were created with frequency
// NOT NULL — SQLite can't relax a column constraint via ALTER, so rebuild the
// table when the old shape is detected. Idempotent: the check exits early
// once the constraint has been dropped.
const freqCol = cols.find(c => c.name === 'frequency');
if (freqCol && freqCol.notnull === 1) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE budget_items_new (
        id              TEXT PRIMARY KEY,
        notion_page_id  TEXT NOT NULL,
        name            TEXT NOT NULL,
        category        TEXT,
        type            TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
        frequency       TEXT CHECK (frequency IN ('once', 'weekly', 'fortnightly', 'monthly', 'annual')),
        recur_interval  INTEGER NOT NULL DEFAULT 1,
        due_date        TEXT NULL,
        is_variable     INTEGER NOT NULL DEFAULT 0,
        bucket          TEXT NOT NULL CHECK (bucket IN ('personal', 'maple')),
        payment         TEXT NOT NULL,
        forecast_amount REAL NOT NULL,
        status          TEXT NOT NULL DEFAULT 'not started',
        deleted_at      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO budget_items_new (
        id, notion_page_id, name, category, type, frequency, recur_interval,
        due_date, is_variable, bucket, payment, forecast_amount, status,
        deleted_at, created_at, updated_at
      )
      SELECT
        id, notion_page_id, name, category, type, frequency, recur_interval,
        due_date, is_variable, bucket, payment, forecast_amount, status,
        deleted_at, created_at, updated_at
      FROM budget_items;
      DROP TABLE budget_items;
      ALTER TABLE budget_items_new RENAME TO budget_items;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_items_notion_page_id
        ON budget_items (notion_page_id);
    `);
  })();
  db.pragma('foreign_keys = ON');
}

export default db;
