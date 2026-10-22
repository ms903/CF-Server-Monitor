import { ensurePathBandwidthTables } from '../database/pathBandwidth.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getAllServers, getServerDetail } from '../utils/cache.js';
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createSuccessResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

export const PATH_BANDWIDTH_BYTES_EACH = 32 * 1024 * 1024;
export const PATH_BANDWIDTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ERROR_RETRY_MS = 15 * 60 * 1000;
const RUN_LEASE_MS = 3 * 60 * 1000;
const BANDWIDTH_PORT = 5201;
const MAX_RESULT_MBPS = 100_000;

function normalizeId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 128 ? id : '';
}

function cleanError(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
}

function normalizeMbps(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > MAX_RESULT_MBPS) return null;
  return Math.round(number * 100) / 100;
}

export function normalizeBandwidthResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const jobId = normalizeId(value.job_id);
  if (!jobId) return null;

  if (value.error) {
    const error = cleanError(value.error);
    return error ? { job_id: jobId, error } : null;
  }

  const vpsToHomeMbps = normalizeMbps(value.vps_to_home_mbps);
  const homeToVpsMbps = normalizeMbps(value.home_to_vps_mbps);
  if (vpsToHomeMbps === null || homeToVpsMbps === null) return null;
  return {
    job_id: jobId,
    error: '',
    vps_to_home_mbps: vpsToHomeMbps,
    home_to_vps_mbps: homeToVpsMbps
  };
}

export function parseBandwidthTarget(value) {
  const input = String(value || '').trim();
  if (!input || input === '0' || input.toLowerCase() === 'false') return '';
  if (input.startsWith('[')) {
    const end = input.indexOf(']');
    return end > 1 ? input.slice(1, end) : '';
  }
  const colonCount = (input.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [host, port] = input.split(':');
    return /^\d+$/.test(port) ? host : input;
  }
  return input;
}

async function getTarget(db, sys) {
  let server = await db.prepare(`
    SELECT id, name FROM servers WHERE node_1 = '0' ORDER BY sort_order ASC LIMIT 1
  `).first();
  if (!server) {
    server = await db.prepare(`
      SELECT id, name FROM servers WHERE lower(name) = 'home server' ORDER BY sort_order ASC LIMIT 1
    `).first();
  }
  const address = parseBandwidthTarget(sys?.node_1);
  return server && address
    ? { id: String(server.id), name: server.name || 'Home Server', address, port: BANDWIDTH_PORT }
    : null;
}

async function authenticateAgent(request, env) {
  const serverId = normalizeId(
    request.headers.get('X-CFSM-Server-ID') || request.headers.get('X-CFSM-Source-ID')
  );
  const secret = request.headers.get('X-CFSM-Secret') || '';
  if (!serverId || !secret || secret !== env.API_SECRET) {
    return { response: createUnauthorizedResponse(), server: null };
  }
  const server = await getServerDetail(env.DB, serverId, true);
  if (!server) {
    return { response: createNotFoundResponse('Server not found'), server: null };
  }
  return { response: null, server };
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

function isDue(row, now) {
  if (!row) return true;
  if (row.status === 'queued') return true;
  const testedAt = Number(row.tested_at) || 0;
  if (!testedAt) return true;
  if (row.status === 'error') return now - testedAt >= ERROR_RETRY_MS;
  return now - testedAt >= PATH_BANDWIDTH_INTERVAL_MS;
}

async function claimJob(env, server, target) {
  if (String(server.id) === target.id) {
    return createSuccessResponse({ enabled: false, job: null, retry_after_seconds: 60 });
  }

  const now = Date.now();
  const current = await env.DB.prepare(`
    SELECT status, requested_at, tested_at FROM path_bandwidth_latest WHERE server_id = ?
  `).bind(server.id).first();
  if (!isDue(current, now)) {
    return createSuccessResponse({ enabled: true, job: null, retry_after_seconds: 30 });
  }

  const jobId = crypto.randomUUID();
  const leaseCutoff = now - RUN_LEASE_MS;
  const result = await env.DB.prepare(`
    INSERT INTO path_bandwidth_latest (
      server_id, status, job_id, requested_at, started_at, tested_at,
      vps_to_home_mbps, home_to_vps_mbps, bytes_each, error
    )
    SELECT ?, 'testing', ?, ?, ?, 0, NULL, NULL, ?, ''
    WHERE NOT EXISTS (
      SELECT 1 FROM path_bandwidth_latest
      WHERE status = 'testing' AND started_at > ?
    )
    ON CONFLICT(server_id) DO UPDATE SET
      status = 'testing', job_id = excluded.job_id, started_at = excluded.started_at,
      bytes_each = excluded.bytes_each, error = ''
    WHERE NOT EXISTS (
      SELECT 1 FROM path_bandwidth_latest
      WHERE status = 'testing' AND started_at > ?
    )
  `).bind(
    server.id,
    jobId,
    Number(current?.requested_at) || now,
    now,
    PATH_BANDWIDTH_BYTES_EACH,
    leaseCutoff,
    leaseCutoff
  ).run();

  if (!Number(result?.meta?.changes || result?.changes || 0)) {
    return createSuccessResponse({ enabled: true, job: null, retry_after_seconds: 15 });
  }

  return createSuccessResponse({
    enabled: true,
    job: {
      id: jobId,
      target: target.address,
      target_name: target.name,
      port: target.port,
      bytes_each: PATH_BANDWIDTH_BYTES_EACH,
      timeout_seconds: 90
    },
    retry_after_seconds: 15
  }, { 'Cache-Control': 'no-store' });
}

async function saveResult(env, server, body) {
  const result = normalizeBandwidthResult(body);
  if (!result) return createBadRequestResponse('Invalid bandwidth result');

  const current = await env.DB.prepare(`
    SELECT job_id, status FROM path_bandwidth_latest WHERE server_id = ?
  `).bind(server.id).first();
  if (!current || current.status !== 'testing' || current.job_id !== result.job_id) {
    return createBadRequestResponse('Bandwidth job is no longer active');
  }

  const testedAt = Date.now();
  const status = result.error ? 'error' : 'ok';
  const vpsToHome = result.error ? null : result.vps_to_home_mbps;
  const homeToVps = result.error ? null : result.home_to_vps_mbps;

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE path_bandwidth_latest SET
        status = ?, tested_at = ?, vps_to_home_mbps = ?, home_to_vps_mbps = ?, error = ?
      WHERE server_id = ? AND job_id = ?
    `).bind(status, testedAt, vpsToHome, homeToVps, result.error, server.id, result.job_id),
    env.DB.prepare(`
      INSERT INTO path_bandwidth_history (
        server_id, tested_at, vps_to_home_mbps, home_to_vps_mbps, bytes_each, status, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      server.id,
      testedAt,
      vpsToHome,
      homeToVps,
      PATH_BANDWIDTH_BYTES_EACH,
      status,
      result.error
    )
  ]);

  return createSuccessResponse({ success: true, status, tested_at: testedAt });
}

export async function handlePathBandwidthAgent(request, env, sys) {
  await ensurePathBandwidthTables(env.DB);
  const auth = await authenticateAgent(request, env);
  if (auth.response) return auth.response;
  const target = await getTarget(env.DB, sys);
  if (!target) return createBadRequestResponse('Home Server bandwidth target is not configured');

  const body = await parseJson(request);
  if (!body || (body.action !== 'claim' && body.action !== 'result')) {
    return createBadRequestResponse('Invalid bandwidth action');
  }
  if (body.action === 'claim') return claimJob(env, auth.server, target);
  return saveResult(env, auth.server, body);
}

export async function handlePathBandwidthAPI(request, env, sys) {
  await ensurePathBandwidthTables(env.DB);
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();

  const target = await getTarget(env.DB, sys);
  if (!target) {
    return createSuccessResponse({ target: null, servers: [] }, { 'Cache-Control': 'no-store' });
  }

  const [servers, rows] = await Promise.all([
    getAllServers(env.DB, isLoggedIn),
    env.DB.prepare(`SELECT * FROM path_bandwidth_latest`).all()
  ]);
  const byId = new Map((rows.results || []).map(row => [String(row.server_id), row]));
  const measuredServers = servers
    .filter(server => String(server.id) !== target.id)
    .map(server => {
      const row = byId.get(String(server.id)) || {};
      return {
        id: server.id,
        name: server.name || server.id,
        region: server.region || '',
        status: row.status || 'waiting',
        requested_at: Number(row.requested_at) || 0,
        started_at: Number(row.started_at) || 0,
        tested_at: Number(row.tested_at) || 0,
        vps_to_home_mbps: row.vps_to_home_mbps == null ? null : Number(row.vps_to_home_mbps),
        home_to_vps_mbps: row.home_to_vps_mbps == null ? null : Number(row.home_to_vps_mbps),
        error: row.error || ''
      };
    });

  return createSuccessResponse({
    target: { id: target.id, name: target.name },
    can_trigger: isLoggedIn,
    interval_hours: PATH_BANDWIDTH_INTERVAL_MS / 3_600_000,
    bytes_each: PATH_BANDWIDTH_BYTES_EACH,
    estimated_monthly_bytes: PATH_BANDWIDTH_BYTES_EACH * 2 * measuredServers.length * 30,
    servers: measuredServers
  }, { 'Cache-Control': 'no-store' });
}

export async function handlePathBandwidthTrigger(request, env, sys) {
  await ensurePathBandwidthTables(env.DB);
  if (!await checkAuth(request, env, sys)) return simpleAuthResponse();
  const target = await getTarget(env.DB, sys);
  if (!target) return createBadRequestResponse('Home Server bandwidth target is not configured');

  const body = await parseJson(request);
  if (!body) return createBadRequestResponse('Invalid JSON');
  const requestedId = normalizeId(body.server_id);
  const servers = (await getAllServers(env.DB, true))
    .filter(server => String(server.id) !== target.id)
    .filter(server => !requestedId || String(server.id) === requestedId);
  if (requestedId && servers.length === 0) return createNotFoundResponse('Server not found');
  if (servers.length === 0) return createBadRequestResponse('No bandwidth probe servers');

  const now = Date.now();
  await env.DB.batch(servers.map(server => env.DB.prepare(`
    INSERT INTO path_bandwidth_latest (server_id, status, requested_at, error)
    VALUES (?, 'queued', ?, '')
    ON CONFLICT(server_id) DO UPDATE SET
      status = CASE WHEN path_bandwidth_latest.status = 'testing' THEN 'testing' ELSE 'queued' END,
      requested_at = excluded.requested_at,
      error = CASE WHEN path_bandwidth_latest.status = 'testing' THEN path_bandwidth_latest.error ELSE '' END
  `).bind(server.id, now)));

  return createSuccessResponse({ success: true, queued: servers.length, requested_at: now });
}
