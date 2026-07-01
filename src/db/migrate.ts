import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

async function migrate() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id    SERIAL PRIMARY KEY,
        name  VARCHAR(255) NOT NULL UNIQUE,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: completed } = await client.query('SELECT name FROM _migrations ORDER BY id');
    const alreadyRan = new Set(completed.map((r: { name: string }) => r.name));

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ranCount = 0;

    for (const file of files) {
      if (alreadyRan.has(file)) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      console.log(`[migrate] Running ${file}...`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] ✓ ${file}`);
        ranCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ✗ ${file} failed:`, err instanceof Error ? err.message : err);
        process.exit(1);
      }
    }

    if (ranCount === 0) {
      console.log('[migrate] All migrations already applied.');
    } else {
      console.log(`[migrate] Done — ${ranCount} migration(s) applied.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
