import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import {
  handleSourceLatencyAPI,
  handleSourceLatencyTargets,
  handleSourceLatencyUpdate,
  normalizeSourceLatencySample,
  normalizeTargetAddress
} from '../src/handlers/sourceLatency.js';
import { clearAllCaches, setLatestMetricsCache } from '../src/utils/cache.js';

function createMiniflare() {
  return new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'source-latency-test' }
  });
}

async function seedServers(db) {
  await db.prepare(`
    CREATE TABLE servers (
      id TEXT PRIMARY KEY,
      name TEXT,
      server_group TEXT DEFAULT '',
      region TEXT DEFAULT '',
      is_hidden TEXT DEFAULT '0',
      sort_order INTEGER DEFAULT 0,
      history_partition_id INTEGER DEFAULT 0,
      timestamp INTEGER DEFAULT 0
    )
  `).run();
  await db.prepare(`
    INSERT INTO servers (id, name, region, sort_order) VALUES
      ('home', 'Home Server', 'CHINA', 0),
      ('hk', 'Hong Kong', 'HONGKONG', 1),
      ('us', 'United States', 'UNITEDSTATES', 2)
  `).run();
}

function sourceRequest(path, options = {}) {
  return new Request(`https://monitor.example${path}`, {
    ...options,
    headers: {
      'X-CFSM-Source-ID': 'home',
      'X-CFSM-Secret': 'test-secret',
      ...(options.headers || {})
    }
  });
}

test('normalizes only safe public IP targets and bounded samples', () => {
  assert.equal(normalizeTargetAddress('203.0.113.7', 'ipv4'), '203.0.113.7');
  assert.equal(normalizeTargetAddress('999.1.1.1', 'ipv4'), '');
  assert.equal(normalizeTargetAddress('2001:db8::7', 'ipv6'), '2001:db8::7');
  assert.equal(normalizeTargetAddress('example.com; rm -rf /', 'ipv6'), '');

  assert.deepEqual(normalizeSourceLatencySample({
    target_id: 'hk',
    family: 'IPv4',
    latency_ms: 18.26,
    loss_percent: 0,
    method: 'icmp'
  }), {
    target_id: 'hk',
    family: 'ipv4',
    latency_ms: 18.3,
    loss_percent: 0,
    method: 'icmp',
    error: ''
  });
  assert.equal(normalizeSourceLatencySample({ target_id: 'hk', family: 'ipv5' }), null);
});

test('source probe discovers every other server and publishes IPv4/IPv6 results', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await seedServers(db);
    clearAllCaches();
    setLatestMetricsCache(new Map([
      ['hk', { ip_v4: '203.0.113.10', ip_v6: '2001:db8::10' }],
      ['us', { ip_v4: '198.51.100.20', ip_v6: '0' }]
    ]));
    const env = { DB: db, API_SECRET: 'test-secret' };

    const targetsResponse = await handleSourceLatencyTargets(
      sourceRequest('/source-latency/targets'),
      env
    );
    assert.equal(targetsResponse.status, 200);
    const targets = await targetsResponse.json();
    assert.equal(targets.source.name, 'Home Server');
    assert.deepEqual(targets.targets.map(item => item.id), ['hk', 'us']);
    assert.equal(targets.targets[0].addresses.ipv6, '2001:db8::10');
    assert.equal(targets.targets[1].addresses.ipv6, '');

    const updateResponse = await handleSourceLatencyUpdate(sourceRequest('/source-latency/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: 'home',
        samples: [
          { target_id: 'hk', family: 'ipv4', latency_ms: 18.4, loss_percent: 0, method: 'icmp' },
          { target_id: 'hk', family: 'ipv6', latency_ms: 22.1, loss_percent: 0, method: 'icmp' },
          { target_id: 'us', family: 'ipv4', latency_ms: null, loss_percent: 100, method: 'unreachable', error: 'timeout' }
        ]
      })
    }), env);
    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).accepted, 3);

    const dashboardResponse = await handleSourceLatencyAPI(
      new Request('https://monitor.example/api/source-latency'),
      env,
      { is_public: 'true', source_latency_source_id: 'home' }
    );
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.source.name, 'Home Server');
    assert.equal(dashboard.targets.length, 2);
    assert.equal(dashboard.targets[0].families.ipv4.latency_ms, 18.4);
    assert.equal(dashboard.targets[0].families.ipv6.latency_ms, 22.1);
    assert.equal(dashboard.targets[1].families.ipv4.method, 'unreachable');
    assert.equal(dashboard.targets[1].available.ipv6, false);
  } finally {
    clearAllCaches();
    await miniflare.dispose();
  }
});

test('source endpoints reject invalid credentials and unknown targets', async () => {
  const miniflare = createMiniflare();
  try {
    const db = await miniflare.getD1Database('DB');
    await seedServers(db);
    clearAllCaches();
    setLatestMetricsCache(new Map());
    const env = { DB: db, API_SECRET: 'test-secret' };

    const unauthorized = await handleSourceLatencyTargets(new Request(
      'https://monitor.example/source-latency/targets',
      { headers: { 'X-CFSM-Source-ID': 'home', 'X-CFSM-Secret': 'wrong' } }
    ), env);
    assert.equal(unauthorized.status, 401);

    const unknownTarget = await handleSourceLatencyUpdate(sourceRequest('/source-latency/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_id: 'home',
        samples: [{ target_id: 'deleted', family: 'ipv4', latency_ms: 5, loss_percent: 0, method: 'icmp' }]
      })
    }), env);
    assert.equal(unknownTarget.status, 400);
  } finally {
    clearAllCaches();
    await miniflare.dispose();
  }
});
