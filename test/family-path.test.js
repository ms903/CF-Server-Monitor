import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __test,
  FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS,
  FAMILY_PATH_DOWNLOAD_BYTES,
  FAMILY_PATH_UPLOAD_BYTES
} from '../src/handlers/familyPath.js';

test('keeps IPv4 and IPv6 as independent path families', () => {
  assert.equal(__test.normalizeFamily('IPv4'), 'ipv4');
  assert.equal(__test.normalizeFamily('ipv6'), 'ipv6');
  assert.equal(__test.normalizeFamily('auto'), '');
});

test('uses a bounded six-hour bidirectional speed test', () => {
  assert.equal(FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS, 6);
  assert.equal(FAMILY_PATH_DOWNLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(FAMILY_PATH_UPLOAD_BYTES, 2 * 1024 * 1024);
});

test('accepts a latency result for one address family', () => {
  const sample = __test.normalizeLatencySample({
    server_name: 'Bage HK 2',
    family: 'ipv6',
    ip_address: '2a14:4900:2207:4b2::82b',
    observed_at: 123456,
    rtt_median_ms: 21.234,
    rtt_p95_ms: 25.6,
    loss_percent: 0,
    jitter_ms: 1.2
  });
  assert.equal(sample.family, 'ipv6');
  assert.equal(sample.rtt_median_ms, 21.234);
  assert.equal(sample.loss_percent, 0);
});

test('accepts and rounds a family-specific bandwidth result', () => {
  assert.deepEqual(__test.normalizeBandwidthResult({
    server_name: 'Bage HK 2',
    family: 'ipv4',
    ip_address: '103.219.195.85',
    observed_at: 123456,
    vps_to_home_mbps: 123.456,
    home_to_vps_mbps: '78.994',
    bytes_transferred: 6291456
  }), {
    server_name: 'Bage HK 2',
    family: 'ipv4',
    ip_address: '103.219.195.85',
    observed_at: 123456,
    vps_to_home_mbps: 123.46,
    home_to_vps_mbps: 78.99,
    bytes_transferred: 6291456,
    error: ''
  });
});

test('accepts a target without inventing a fake bandwidth result', () => {
  assert.deepEqual(__test.normalizeTarget({
    server_name: 'Yecao HK', family: 'ipv6', ip_address: '2001:df1:7880:3::151'
  }), {
    server_name: 'Yecao HK', family: 'ipv6', ip_address: '2001:df1:7880:3::151'
  });
});

import { handleFamilyPathAPI, handleFamilyPathHistory } from '../src/handlers/familyPath.js';
import { clearServersListCache } from '../src/utils/cache.js';

function fakeDB({ servers = [], paths = [], history = [] } = {}) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      queries.push(sql);
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async run() { return {}; },
        async first() { return servers.find(s => s.id === args[0]) || null; },
        async all() {
          if (sql.includes('FROM servers')) return { results: servers };
          if (sql.includes('FROM family_path_latest')) return { results: paths };
          if (sql.includes('FROM family_path_history')) return { results: history };
          return { results: [] };
        }
      };
    }
  };
}

test('latest batches sparklines, retains failure gaps and excludes removed/hidden servers', async () => {
  clearServersListCache();
  const db = fakeDB({
    servers: [{ id: 'a', name: 'A' }, { id: 'hidden', name: 'H', is_hidden: 1 }],
    paths: [{ server_id: 'a', family: 'ipv6' }, { server_id: 'gone', family: 'ipv4' }, { server_id: 'hidden', family: 'ipv4' }],
    history: [
      { server_id: 'a', family: 'ipv6', observed_at: 1, status: 'ok', vps_to_home_mbps: 22, home_to_vps_mbps: 33 },
      { server_id: 'a', family: 'ipv6', observed_at: 2, status: 'error', vps_to_home_mbps: 0, home_to_vps_mbps: 0 }
    ]
  });
  const response = await handleFamilyPathAPI(new Request('https://test/api/family-path?include_sparkline=1'), { DB: db }, { is_public: 'true' });
  const result = await response.json();
  assert.equal(result.paths.length, 1);
  assert.equal(result.can_trigger, false);
  assert.equal(result.paths[0].sparkline[0].vps_to_home_mbps, 22);
  assert.equal(result.paths[0].sparkline[1].vps_to_home_mbps, null);
  assert.equal(db.queries.filter(q => q.includes('FROM family_path_history')).length, 1);
  clearServersListCache();
});

test('default latest response does not query history or change the original wire shape', async () => {
  clearServersListCache();
  const db = fakeDB({ servers: [{ id: 'a', name: 'A' }], paths: [{ server_id: 'a', family: 'ipv4' }] });
  const response = await handleFamilyPathAPI(new Request('https://test/api/family-path'), { DB: db }, { is_public: 'true' });
  const result = await response.json();
  assert.equal('sparkline' in result.paths[0], false);
  assert.equal(db.queries.some(q => q.includes('FROM family_path_history')), false);
  clearServersListCache();
});

test('30-day history includes latest samples beyond the previous 512-row limit', async () => {
  clearServersListCache();
  const history = Array.from({ length: 600 }, (_, n) => ({ observed_at: n + 1, status: n === 599 ? 'error' : 'ok', error: n === 599 ? 'timeout' : '' }));
  const db = fakeDB({ servers: [{ id: 'a', name: 'A' }], history });
  const response = await handleFamilyPathHistory(new Request('https://test/api/family-path/history?server_id=a&family=ipv6&hours=720'), { DB: db }, { is_public: 'true' });
  const result = await response.json();
  assert.equal(result.points.length, 600);
  assert.equal(result.points.at(-1).error, 'timeout');
  assert.equal(db.queries.some(q => /LIMIT 512/.test(q)), false);
  clearServersListCache();
});

test('private family data requires authentication', async () => {
  const response = await handleFamilyPathAPI(new Request('https://test/api/family-path'), { DB: fakeDB() }, { is_public: 'false' });
  assert.equal(response.status, 401);
});
