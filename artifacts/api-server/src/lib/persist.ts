import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env["DATABASE_URL"],
      ssl: process.env["NODE_ENV"] === "production" ? { rejectUnauthorized: false } : false,
    });
    _pool.on("error", (err) => {
      logger.error({ err }, "Unexpected error on idle PostgreSQL client");
    });
  }
  return _pool;
}

async function ensureTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

let _tableReady: Promise<void> | null = null;

function tableReady(): Promise<void> {
  if (!_tableReady) {
    _tableReady = ensureTable().catch((err) => {
      logger.error({ err }, "Failed to ensure kv_store table");
      _tableReady = null;
      throw err;
    });
  }
  return _tableReady;
}

export async function readJsonAsync<T>(name: string, defaultValue: T): Promise<T> {
  try {
    await tableReady();
    const pool = getPool();
    const result = await pool.query<{ value: T }>(
      "SELECT value FROM kv_store WHERE key = $1",
      [name]
    );
    if (result.rows.length > 0) {
      return result.rows[0].value as T;
    }
  } catch (err) {
    logger.warn({ err, key: name }, "Failed to read from kv_store");
  }
  return defaultValue;
}

export async function writeJsonAsync(name: string, value: unknown): Promise<void> {
  try {
    await tableReady();
    const pool = getPool();
    await pool.query(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [name, JSON.stringify(value)]
    );
  } catch (err) {
    logger.error({ err, key: name }, "Failed to write to kv_store");
  }
}

export function readJson<T>(name: string, defaultValue: T): T {
  logger.warn({ key: name }, "readJson called synchronously — use readJsonAsync for new code");
  return defaultValue;
}

export function writeJson(name: string, value: unknown): void {
  writeJsonAsync(name, value).catch((err) => {
    logger.error({ err, key: name }, "Background writeJson failed");
  });
}
