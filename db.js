const { Pool } = require('pg');

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (e) {}
}

const isTest = process.env.NODE_ENV === 'test';
let connectionString;

if (isTest) {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL is missing. Tests must stop with a clear error instead of falling back to DATABASE_URL.');
  }
  if (process.env.DATABASE_URL && process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must be isolated and different from DATABASE_URL.');
  }
  connectionString = process.env.TEST_DATABASE_URL;
} else {
  connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required.');
  }
}

const pool = new Pool({
  connectionString,
  max: isTest ? 5 : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: true
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

let schemaPromise = null;
async function initSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          CREATE TABLE IF NOT EXISTS orgs(
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            default_threshold INTEGER NOT NULL DEFAULT 5,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE TABLE IF NOT EXISTS products(
            id SERIAL PRIMARY KEY,
            org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sku TEXT NOT NULL,
            description TEXT,
            quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
            cost_price DOUBLE PRECISION,
            selling_price DOUBLE PRECISION,
            low_stock_threshold INTEGER,
            last_updated_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(org_id, sku)
          );
          CREATE TABLE IF NOT EXISTS stock_events(
            id SERIAL PRIMARY KEY,
            org_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            delta INTEGER NOT NULL,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS ix_events_org ON stock_events(org_id, created_at);
        `);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        schemaPromise = null;
        throw err;
      } finally {
        client.release();
      }
    })();
  }
  return schemaPromise;
}

module.exports = {
  pool,
  query: async (text, params) => {
    await initSchema();
    return pool.query(text, params);
  },
  getClient: async () => {
    await initSchema();
    return pool.connect();
  },
  initSchema,
  close: () => pool.end()
};
