import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBandwidthResult,
  parseBandwidthTarget,
  PATH_BANDWIDTH_BYTES_EACH,
  PATH_BANDWIDTH_INTERVAL_MS
} from '../src/handlers/pathBandwidth.js';

test('uses a fixed-size daily test to keep traffic predictable', () => {
  assert.equal(PATH_BANDWIDTH_BYTES_EACH, 32 * 1024 * 1024);
  assert.equal(PATH_BANDWIDTH_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

test('extracts the host from the Home Server ping target', () => {
  assert.equal(parseBandwidthTarget('100.64.115.126:22'), '100.64.115.126');
  assert.equal(parseBandwidthTarget('[fd7a:115c:a1e0::1]:22'), 'fd7a:115c:a1e0::1');
  assert.equal(parseBandwidthTarget('home-server.example'), 'home-server.example');
  assert.equal(parseBandwidthTarget('0'), '');
});

test('accepts and rounds valid bidirectional throughput', () => {
  assert.deepEqual(normalizeBandwidthResult({
    job_id: 'job-1',
    vps_to_home_mbps: 123.456,
    home_to_vps_mbps: '78.994'
  }), {
    job_id: 'job-1',
    error: '',
    vps_to_home_mbps: 123.46,
    home_to_vps_mbps: 78.99
  });
});

test('rejects missing, zero, or implausible throughput', () => {
  assert.equal(normalizeBandwidthResult({ job_id: 'job-1', vps_to_home_mbps: 0, home_to_vps_mbps: 10 }), null);
  assert.equal(normalizeBandwidthResult({ job_id: 'job-1', vps_to_home_mbps: 10, home_to_vps_mbps: 100001 }), null);
  assert.equal(normalizeBandwidthResult({ vps_to_home_mbps: 10, home_to_vps_mbps: 10 }), null);
});

test('keeps a bounded single-line agent error', () => {
  const result = normalizeBandwidthResult({ job_id: 'job-1', error: 'failed\nwith\ttabs' });
  assert.deepEqual(result, { job_id: 'job-1', error: 'failed with tabs' });
});
