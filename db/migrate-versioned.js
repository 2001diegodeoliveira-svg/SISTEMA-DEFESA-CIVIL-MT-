'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function applyMigrations(client, migrationsDir = MIGRATIONS_DIR) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query('SELECT pg_advisory_lock(73104211)');

  try {
    const files = fs.readdirSync(migrationsDir)
      .filter(file => /^\d{12}_[a-z0-9_]+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const version = file.slice(0, -4);
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`A migração aplicada ${version} foi alterada; crie uma nova migração.`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [version, checksum]
        );
        await client.query('COMMIT');
        console.log(`  migração aplicada: ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migração ${version}: ${error.message}`, { cause: error });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(73104211)');
  }
}

module.exports = { applyMigrations, MIGRATIONS_DIR };
