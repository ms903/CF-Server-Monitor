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
