import { ensureFamilyPathTables } from '../database/familyPath.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getAllServers, getServerDetail } from '../utils/cache.js';
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createSuccessResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

export const FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS = 6;
export const FAMILY_PATH_DOWNLOAD_BYTES = 4 * 1024 * 1024;
export const FAMILY_PATH_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_SAMPLES = 32;
const MAX_ERROR_LENGTH = 240;
const MAX_MBPS = 100_000;
const ALLOWED_HISTORY_HOURS = new Set([24, 168, 720]);
const BANDWIDTH_LEASE_MS = 15 * 60 * 1000;
const BANDWIDTH_INTERVAL_MS = FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS * 60 * 60 * 1000;
const BANDWIDTH_ERROR_RETRY_MS = 15 * 60 * 1000;

function cleanText(value, max = 128) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizeFamily(value) {
  const family = String(value || '').toLowerCase();
  return family === 'ipv4' || family === 'ipv6' ? family : '';
}

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function timestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Date.now();
  return Math.round(number);
}

function normalizeLatencySample(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serverName = cleanText(value.server_name, 100);
  const family = normalizeFamily(value.family);
  const ipAddress = cleanText(value.ip_address, 80);
  if (!serverName || !family || !ipAddress) return null;
  const error = cleanText(value.error, MAX_ERROR_LENGTH);
  const rttMedian = finite(value.rtt_median_ms, 0, 600_000);
  const rttP95 = finite(value.rtt_p95_ms, 0, 600_000);
  const loss = finite(value.loss_percent, 0, 100);
  const jitter = finite(value.jitter_ms, 0, 600_000);
  if (!error && (rttMedian === null || loss === null)) return null;
  return {
    server_name: serverName,
    family,
    ip_address: ipAddress,
    observed_at: timestamp(value.observed_at),
    rtt_median_ms: rttMedian,
    rtt_p95_ms: rttP95,
    loss_percent: loss,
    jitter_ms: jitter,
    error
  };
}

function normalizeBandwidthResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serverName = cleanText(value.server_name, 100);
  const family = normalizeFamily(value.family);
  const ipAddress = cleanText(value.ip_address, 80);
  if (!serverName || !family || !ipAddress) return null;
  const error = cleanText(value.error, MAX_ERROR_LENGTH);
  const vpsToHome = finite(value.vps_to_home_mbps, 0.0001, MAX_MBPS);
  const homeToVps = finite(value.home_to_vps_mbps, 0.0001, MAX_MBPS);
  if (!error && (vpsToHome === null || homeToVps === null)) return null;
  return {
    server_name: serverName,
    family,
    ip_address: ipAddress,
    observed_at: timestamp(value.observed_at),
    vps_to_home_mbps: vpsToHome === null ? null : Math.round(vpsToHome * 100) / 100,
    home_to_vps_mbps: homeToVps === null ? null : Math.round(homeToVps * 100) / 100,
    bytes_transferred: Math.round(finite(value.bytes_transferred, 0, 1024 ** 4) || 0),
    error
  };
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const serverName = cleanText(value.server_name, 100);
  const family = normalizeFamily(value.family);
  const ipAddress = cleanText(value.ip_address, 80);
  return serverName && family && ipAddress
    ? { server_name: serverName, family, ip_address: ipAddress }
    : null;
}

async function authenticateCollector(request, env) {
  const serverId = cleanText(request.headers.get('X-CFSM-Server-ID'), 128);
  const secret = request.headers.get('X-CFSM-Secret') || '';
  if (!serverId || !secret || secret !== env.API_SECRET) {
    return { response: createUnauthorizedResponse(), server: null };
  }
  const server = await getServerDetail(env.DB, serverId, true);
  if (!server) return { response: createNotFoundResponse('Collector server not found'), server: null };
  if (String(server.name || '').trim().toLowerCase() !== 'home server') {
    return { response: createUnauthorizedResponse(), server: null };
  }
  return { response: null, server };
}

async function jsonBody(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

async function serverMap(db) {
  const servers = await getAllServers(db, true);
  return new Map(servers.map(server => [String(server.name || '').trim().toLowerCase(), server]));
}

async function saveLatencyBatch(env, body) {
  if (!Array.isArray(body.samples) || body.samples.length === 0 || body.samples.length > MAX_BATCH_SAMPLES) {
    return createBadRequestResponse('Invalid latency sample batch');
  }
  const samples = body.samples.map(normalizeLatencySample);
  if (samples.some(sample => !sample)) return createBadRequestResponse('Invalid latency sample');
  const servers = await serverMap(env.DB);
  const statements = [];
  for (const sample of samples) {
    const server = servers.get(sample.server_name.toLowerCase());
    if (!server || String(server.name).toLowerCase() === 'home server') continue;
    statements.push(env.DB.prepare(`
      INSERT INTO family_path_latest (
        server_id, family, ip_address, latency_status, latency_at,
        rtt_median_ms, rtt_p95_ms, loss_percent, jitter_ms, latency_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, family) DO UPDATE SET
        ip_address = excluded.ip_address,
        latency_status = excluded.latency_status,
        latency_at = excluded.latency_at,
        rtt_median_ms = excluded.rtt_median_ms,
        rtt_p95_ms = excluded.rtt_p95_ms,
        loss_percent = excluded.loss_percent,
        jitter_ms = excluded.jitter_ms,
        latency_error = excluded.latency_error
      WHERE excluded.latency_at >= family_path_latest.latency_at
    `).bind(
      server.id,
      sample.family,
      sample.ip_address,
      sample.error ? 'error' : 'ok',
      sample.observed_at,
      sample.rtt_median_ms,
      sample.rtt_p95_ms,
      sample.loss_percent,
      sample.jitter_ms,
      sample.error
    ));
  }
  if (statements.length) await env.DB.batch(statements);
  return createSuccessResponse({ success: true, accepted: statements.length });
}

async function markBandwidthStart(env, body) {
  const result = normalizeTarget(body);
  if (!result) return createBadRequestResponse('Invalid bandwidth target');
  const servers = await serverMap(env.DB);
  const server = servers.get(result.server_name.toLowerCase());
  if (!server) return createNotFoundResponse('Server not found');
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO family_path_latest (
      server_id, family, ip_address, bandwidth_status, bandwidth_started_at, bandwidth_error
    ) VALUES (?, ?, ?, 'testing', ?, '')
    ON CONFLICT(server_id, family) DO UPDATE SET
      ip_address = excluded.ip_address,
      bandwidth_status = 'testing',
      bandwidth_started_at = excluded.bandwidth_started_at,
      bandwidth_error = ''
  `).bind(server.id, result.family, result.ip_address, now).run();
  return createSuccessResponse({ success: true, started_at: now });
}

async function saveBandwidthResult(env, body) {
  const result = normalizeBandwidthResult(body);
  if (!result) return createBadRequestResponse('Invalid bandwidth result');
  const servers = await serverMap(env.DB);
  const server = servers.get(result.server_name.toLowerCase());
  if (!server) return createNotFoundResponse('Server not found');
  const status = result.error ? 'error' : 'ok';
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO family_path_latest (
        server_id, family, ip_address, bandwidth_status, bandwidth_at,
        vps_to_home_mbps, home_to_vps_mbps, bandwidth_bytes, bandwidth_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, family) DO UPDATE SET
        ip_address = excluded.ip_address,
        bandwidth_status = excluded.bandwidth_status,
        bandwidth_at = CASE WHEN excluded.bandwidth_status = 'ok' THEN excluded.bandwidth_at ELSE family_path_latest.bandwidth_at END,
        vps_to_home_mbps = CASE WHEN excluded.bandwidth_status = 'ok' THEN excluded.vps_to_home_mbps ELSE family_path_latest.vps_to_home_mbps END,
        home_to_vps_mbps = CASE WHEN excluded.bandwidth_status = 'ok' THEN excluded.home_to_vps_mbps ELSE family_path_latest.home_to_vps_mbps END,
        bandwidth_bytes = CASE WHEN excluded.bandwidth_status = 'ok' THEN excluded.bandwidth_bytes ELSE family_path_latest.bandwidth_bytes END,
        bandwidth_error = excluded.bandwidth_error
      WHERE excluded.bandwidth_at >= family_path_latest.bandwidth_started_at
    `).bind(
      server.id,
      result.family,
      result.ip_address,
      status,
      result.observed_at,
      result.vps_to_home_mbps,
      result.home_to_vps_mbps,
      result.bytes_transferred,
      result.error
    ),
    env.DB.prepare(`
      INSERT INTO family_path_history (
        server_id, family, observed_at, vps_to_home_mbps, home_to_vps_mbps,
        bytes_transferred, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, family, observed_at) DO UPDATE SET
        vps_to_home_mbps = excluded.vps_to_home_mbps,
        home_to_vps_mbps = excluded.home_to_vps_mbps,
        bytes_transferred = excluded.bytes_transferred,
        status = excluded.status,
        error = excluded.error
    `).bind(
      server.id,
      result.family,
      result.observed_at,
      result.vps_to_home_mbps,
      result.home_to_vps_mbps,
      result.bytes_transferred,
      status,
      result.error
    )
  ]);
  return createSuccessResponse({ success: true, status, observed_at: result.observed_at });
}

async function claimManualJob(env) {
  const now = Date.now();
  const staleBefore = now - BANDWIDTH_LEASE_MS;
  await env.DB.prepare(`
    UPDATE family_path_latest
    SET bandwidth_status = 'queued', bandwidth_error = 'previous test timed out'
    WHERE bandwidth_status = 'testing'
      AND bandwidth_requested_at > 0
      AND bandwidth_started_at > 0
      AND bandwidth_started_at < ?
  `).bind(staleBefore).run();
  const row = await env.DB.prepare(`
    SELECT f.server_id, f.family, f.ip_address, f.bandwidth_status, s.name
    FROM family_path_latest f
    JOIN servers s ON s.id = f.server_id
    WHERE f.ip_address != '' AND (
      f.bandwidth_status = 'queued'
      OR f.bandwidth_status = 'waiting'
      OR (f.bandwidth_status = 'error' AND f.bandwidth_started_at < ?)
      OR (f.bandwidth_status = 'ok' AND f.bandwidth_at < ?)
    )
    ORDER BY
      CASE f.bandwidth_status WHEN 'queued' THEN 0 WHEN 'waiting' THEN 1 WHEN 'error' THEN 2 ELSE 3 END,
      f.bandwidth_requested_at ASC,
      f.bandwidth_at ASC
    LIMIT 1
  `).bind(now - BANDWIDTH_ERROR_RETRY_MS, now - BANDWIDTH_INTERVAL_MS).first();
  if (!row) return createSuccessResponse({ job: null, retry_after_seconds: 15 });
  const update = await env.DB.prepare(`
    UPDATE family_path_latest
    SET bandwidth_status = 'testing', bandwidth_requested_at = ?, bandwidth_started_at = ?, bandwidth_error = ''
    WHERE server_id = ? AND family = ? AND bandwidth_status != 'testing'
  `).bind(now, now, row.server_id, row.family).run();
  if (!Number(update?.meta?.changes || update?.changes || 0)) {
    return createSuccessResponse({ job: null, retry_after_seconds: 3 });
  }
  return createSuccessResponse({
    job: {
      server_name: row.name,
      family: row.family,
      ip_address: row.ip_address,
      download_bytes: FAMILY_PATH_DOWNLOAD_BYTES,
      upload_bytes: FAMILY_PATH_UPLOAD_BYTES
    },
    retry_after_seconds: 3
  });
}

export async function handleFamilyPathAgent(request, env) {
  await ensureFamilyPathTables(env.DB);
  const auth = await authenticateCollector(request, env);
  if (auth.response) return auth.response;
  const body = await jsonBody(request);
  if (!body || typeof body.action !== 'string') return createBadRequestResponse('Invalid action');
  if (body.action === 'latency') return saveLatencyBatch(env, body);
  if (body.action === 'bandwidth_start') return markBandwidthStart(env, body);
  if (body.action === 'bandwidth_result') return saveBandwidthResult(env, body);
  if (body.action === 'claim') return claimManualJob(env);
  return createBadRequestResponse('Invalid action');
}

export async function handleFamilyPathAPI(request, env, sys) {
  await ensureFamilyPathTables(env.DB);
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();
  const [servers, rows] = await Promise.all([
    getAllServers(env.DB, isLoggedIn),
    env.DB.prepare('SELECT * FROM family_path_latest').all()
  ]);
  const byId = new Map(servers.map(server => [String(server.id), server]));
  const paths = (rows.results || [])
    .map(row => ({
      server_id: row.server_id,
      server_name: byId.get(String(row.server_id))?.name || row.server_id,
      region: byId.get(String(row.server_id))?.region || '',
      family: row.family,
      ip_address: row.ip_address,
      latency_status: row.latency_status,
      latency_at: Number(row.latency_at) || 0,
      rtt_median_ms: row.rtt_median_ms == null ? null : Number(row.rtt_median_ms),
      rtt_p95_ms: row.rtt_p95_ms == null ? null : Number(row.rtt_p95_ms),
      loss_percent: row.loss_percent == null ? null : Number(row.loss_percent),
      jitter_ms: row.jitter_ms == null ? null : Number(row.jitter_ms),
      latency_error: row.latency_error || '',
      bandwidth_status: row.bandwidth_status,
      bandwidth_requested_at: Number(row.bandwidth_requested_at) || 0,
      bandwidth_started_at: Number(row.bandwidth_started_at) || 0,
      bandwidth_at: Number(row.bandwidth_at) || 0,
      vps_to_home_mbps: row.vps_to_home_mbps == null ? null : Number(row.vps_to_home_mbps),
      home_to_vps_mbps: row.home_to_vps_mbps == null ? null : Number(row.home_to_vps_mbps),
      bandwidth_bytes: Number(row.bandwidth_bytes) || 0,
      bandwidth_error: row.bandwidth_error || ''
    }))
    .sort((a, b) => a.server_name.localeCompare(b.server_name) || a.family.localeCompare(b.family));
  const familyCount = paths.length;
  return createSuccessResponse({
    can_trigger: isLoggedIn,
    bandwidth_interval_hours: FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS,
    max_bytes_per_test: FAMILY_PATH_DOWNLOAD_BYTES + FAMILY_PATH_UPLOAD_BYTES,
    estimated_monthly_bytes: familyCount * (24 / FAMILY_PATH_BANDWIDTH_INTERVAL_HOURS) * 30 * (FAMILY_PATH_DOWNLOAD_BYTES + FAMILY_PATH_UPLOAD_BYTES),
    paths
  }, { 'Cache-Control': 'no-store' });
}

export async function handleFamilyPathHistory(request, env, sys) {
  await ensureFamilyPathTables(env.DB);
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();
  const url = new URL(request.url);
  const serverId = cleanText(url.searchParams.get('server_id'), 128);
  const family = normalizeFamily(url.searchParams.get('family'));
  const hours = Number(url.searchParams.get('hours') || 168);
  if (!serverId || !family || !ALLOWED_HISTORY_HOURS.has(hours)) {
    return createBadRequestResponse('Invalid history query');
  }
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`
    SELECT observed_at, vps_to_home_mbps, home_to_vps_mbps, bytes_transferred, status, error
    FROM family_path_history
    WHERE server_id = ? AND family = ? AND observed_at >= ?
    ORDER BY observed_at ASC
    LIMIT 512
  `).bind(serverId, family, cutoff).all();
  return createSuccessResponse({
    server_id: serverId,
    family,
    hours,
    points: (rows.results || []).map(row => ({
      observed_at: Number(row.observed_at),
      vps_to_home_mbps: row.vps_to_home_mbps == null ? null : Number(row.vps_to_home_mbps),
      home_to_vps_mbps: row.home_to_vps_mbps == null ? null : Number(row.home_to_vps_mbps),
      bytes_transferred: Number(row.bytes_transferred) || 0,
      status: row.status,
      error: row.error || ''
    }))
  }, { 'Cache-Control': 'no-store' });
}

export async function handleFamilyPathTrigger(request, env, sys) {
  await ensureFamilyPathTables(env.DB);
  if (!await checkAuth(request, env, sys)) return simpleAuthResponse();
  const body = await jsonBody(request);
  if (!body) return createBadRequestResponse('Invalid JSON');
  const requestedId = cleanText(body.server_id, 128);
  const requestedFamily = body.family ? normalizeFamily(body.family) : '';
  if (body.family && !requestedFamily) return createBadRequestResponse('Invalid family');
  let rows = (await env.DB.prepare(`
    SELECT server_id, family FROM family_path_latest ORDER BY server_id, family
  `).all()).results || [];
  if (requestedId) rows = rows.filter(row => String(row.server_id) === requestedId);
  if (requestedFamily) rows = rows.filter(row => row.family === requestedFamily);
  if (!rows.length) return createNotFoundResponse('Path not found');
  const now = Date.now();
  await env.DB.batch(rows.map(row => env.DB.prepare(`
    UPDATE family_path_latest SET
      bandwidth_status = CASE WHEN bandwidth_status = 'testing' THEN 'testing' ELSE 'queued' END,
      bandwidth_requested_at = ?,
      bandwidth_error = CASE WHEN bandwidth_status = 'testing' THEN bandwidth_error ELSE '' END
    WHERE server_id = ? AND family = ?
  `).bind(now, row.server_id, row.family)));
  return createSuccessResponse({ success: true, queued: rows.length, requested_at: now });
}

export const __test = {
  normalizeFamily,
  normalizeLatencySample,
  normalizeBandwidthResult,
  normalizeTarget
};
