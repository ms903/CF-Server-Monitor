export async function ensureFamilyPathTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS family_path_latest (
      server_id TEXT NOT NULL,
      family TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      latency_status TEXT NOT NULL DEFAULT 'waiting',
      latency_at INTEGER NOT NULL DEFAULT 0,
      rtt_median_ms REAL,
      rtt_p95_ms REAL,
      loss_percent REAL,
      jitter_ms REAL,
      latency_error TEXT NOT NULL DEFAULT '',
      bandwidth_status TEXT NOT NULL DEFAULT 'waiting',
      bandwidth_requested_at INTEGER NOT NULL DEFAULT 0,
      bandwidth_started_at INTEGER NOT NULL DEFAULT 0,
      bandwidth_at INTEGER NOT NULL DEFAULT 0,
      vps_to_home_mbps REAL,
      home_to_vps_mbps REAL,
      bandwidth_bytes INTEGER NOT NULL DEFAULT 0,
      bandwidth_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (server_id, family)
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS family_path_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      family TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      vps_to_home_mbps REAL,
      home_to_vps_mbps REAL,
      bytes_transferred INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT ''
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_family_path_history_server_family_time
    ON family_path_history(server_id, family, observed_at DESC)
  `).run();

  await db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_family_path_history_unique_sample
    ON family_path_history(server_id, family, observed_at)
  `).run();
}
