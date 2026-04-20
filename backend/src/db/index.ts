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

// Idempotent migration: add recur_interval column if an older DB predates it.
// CREATE TABLE IF NOT EXISTS above is a no-op for existing tables, so schema
// changes to existing columns must be applied explicitly here.
const cols = db.pragma('table_info(budget_items)') as Array<{ name: string }>;
if (!cols.some(c => c.name === 'recur_interval')) {
  db.exec('ALTER TABLE budget_items ADD COLUMN recur_interval INTEGER NOT NULL DEFAULT 1');
}
if (!cols.some(c => c.name === 'status')) {
  db.exec("ALTER TABLE budget_items ADD COLUMN status TEXT NOT NULL DEFAULT 'not started'");
}

export default db;
