export async function ensurePathBandwidthTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS path_bandwidth_latest (
      server_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      job_id TEXT NOT NULL DEFAULT '',
      requested_at INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL DEFAULT 0,
      tested_at INTEGER NOT NULL DEFAULT 0,
      vps_to_home_mbps REAL,
      home_to_vps_mbps REAL,
      bytes_each INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS path_bandwidth_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      tested_at INTEGER NOT NULL,
      vps_to_home_mbps REAL,
      home_to_vps_mbps REAL,
      bytes_each INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT ''
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_path_bandwidth_history_server_time
    ON path_bandwidth_history(server_id, tested_at DESC)
  `).run();
}
