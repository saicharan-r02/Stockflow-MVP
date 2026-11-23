const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'stockflow.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS orgs(id INTEGER PRIMARY KEY, name TEXT NOT NULL, default_threshold INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id), name TEXT NOT NULL, sku TEXT NOT NULL, description TEXT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0), cost_price REAL, selling_price REAL, low_stock_threshold INTEGER, last_updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(org_id, sku));
-- lightweight quantity deltas; powers the stock-trend chart (no FK so history survives deletes)
CREATE TABLE IF NOT EXISTS stock_events(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, product_id INTEGER NOT NULL, delta INTEGER NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_events_org ON stock_events(org_id, created_at);
`);
module.exports = db;
