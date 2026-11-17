// Tests only: the D1 `{query, batch}` executor over node:sqlite in memory.
// The schema is a copy of factory-cli migrations/d1/0008_demo_shards.sql,
// 0009_shard_deployments.sql and 0014_demo_manifest_fingerprints.sql; factory-cli
// owns it in production.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE demo_placements (slug TEXT PRIMARY KEY, shard TEXT NOT NULL, lead_id INTEGER, file_count INTEGER NOT NULL, updated_at TEXT NOT NULL, fingerprint TEXT);
CREATE INDEX idx_demo_placements_shard ON demo_placements(shard);
CREATE TABLE shard_locks (shard TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE shard_deployments (shard TEXT PRIMARY KEY, url TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

export function createSqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const run = ({ sql, params = [] }) => db.prepare(sql).all(...params).map((row) => ({ ...row }));
  return {
    raw: db,
    query: async (sql, params = []) => run({ sql, params }),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(run);
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
