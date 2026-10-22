export async function ensureSourceLatencyTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS source_latency (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      family TEXT NOT NULL CHECK (family IN ('ipv4', 'ipv6')),
      timestamp INTEGER NOT NULL,
      latency_ms REAL,
      loss_percent REAL,
      method TEXT NOT NULL DEFAULT 'icmp',
      error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_id, target_id, family)
    )
  `).run();
}
