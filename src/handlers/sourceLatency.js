import { getLatestMetricsForAllServers } from '../database/schema.js';
import { ensureSourceLatencyTable } from '../database/sourceLatency.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getAllServers, getServerDetail } from '../utils/cache.js';
import {
  createBadRequestResponse,
  createNotFoundResponse,
  createSuccessResponse,
  createUnauthorizedResponse
} from '../utils/errors.js';

const MAX_SAMPLES = 256;
const MAX_REQUEST_BYTES = 64 * 1024;
const VALID_FAMILIES = new Set(['ipv4', 'ipv6']);
const VALID_METHODS = new Set(['icmp', 'tcp/22', 'unreachable']);

function normalizeId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 128 ? id : '';
}

function getSourceCredentials(request) {
  return {
    sourceId: normalizeId(request.headers.get('X-CFSM-Source-ID')),
    secret: request.headers.get('X-CFSM-Secret') || ''
  };
}

function isValidIPv4(value) {
  const parts = String(value || '').trim().split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isValidIPv6(value) {
  const address = String(value || '').trim();
  return address.includes(':') && address.length <= 64 && /^[0-9a-fA-F:.]+$/.test(address);
}

export function normalizeTargetAddress(value, family) {
  const address = String(value || '').trim();
  if (!address || address === '0' || address.toLowerCase() === 'false') return '';
  if (family === 'ipv4') return isValidIPv4(address) ? address : '';
  if (family === 'ipv6') return isValidIPv6(address) ? address : '';
  return '';
}

function normalizeFiniteNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return Math.round(number * 10) / 10;
}

export function normalizeSourceLatencySample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
  const targetId = normalizeId(sample.target_id);
  const family = String(sample.family || '').trim().toLowerCase();
  if (!targetId || !VALID_FAMILIES.has(family)) return null;

  const latencyMs = normalizeFiniteNumber(sample.latency_ms, 0, 120_000);
  const lossPercent = normalizeFiniteNumber(sample.loss_percent, 0, 100);
  const requestedMethod = String(sample.method || '').trim().toLowerCase();
  const method = VALID_METHODS.has(requestedMethod)
    ? requestedMethod
    : (latencyMs === null ? 'unreachable' : 'icmp');

  if (latencyMs === null && lossPercent === null && method !== 'unreachable') return null;

  return {
    target_id: targetId,
    family,
    latency_ms: latencyMs,
    loss_percent: lossPercent,
    method,
    error: String(sample.error || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160)
  };
}

async function authenticateSource(request, env) {
  const { sourceId, secret } = getSourceCredentials(request);
  if (!sourceId || !secret || secret !== env.API_SECRET) {
    return { response: createUnauthorizedResponse(), source: null };
  }

  const source = await getServerDetail(env.DB, sourceId, true);
  if (!source) {
    return { response: createNotFoundResponse('Source server not found'), source: null };
  }
  return { response: null, source };
}

export async function handleSourceLatencyTargets(request, env) {
  await ensureSourceLatencyTable(env.DB);
  const auth = await authenticateSource(request, env);
  if (auth.response) return auth.response;

  const [servers, latestMetrics] = await Promise.all([
    getAllServers(env.DB, true),
    getLatestMetricsForAllServers(env.DB)
  ]);

  const targets = servers
    .filter(server => String(server.id) !== String(auth.source.id))
    .map(server => {
      const metrics = latestMetrics.get(server.id) || {};
      return {
        id: server.id,
        name: server.name || server.id,
        region: server.region || '',
        addresses: {
          ipv4: normalizeTargetAddress(metrics.ip_v4, 'ipv4'),
          ipv6: normalizeTargetAddress(metrics.ip_v6, 'ipv6')
        }
      };
    });

  return createSuccessResponse({
    source: { id: auth.source.id, name: auth.source.name || auth.source.id },
    interval_seconds: 60,
    targets
  }, { 'Cache-Control': 'no-store' });
}

export async function handleSourceLatencyUpdate(request, env) {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return new Response(JSON.stringify({ error: 'Payload too large', code: 413 }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  await ensureSourceLatencyTable(env.DB);
  const auth = await authenticateSource(request, env);
  if (auth.response) return auth.response;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return createBadRequestResponse('Invalid JSON');
  }

  if (body?.source_id && normalizeId(body.source_id) !== String(auth.source.id)) {
    return createBadRequestResponse('Source ID mismatch');
  }
  if (!Array.isArray(body?.samples) || body.samples.length > MAX_SAMPLES) {
    return createBadRequestResponse('Invalid samples');
  }

  const samples = body.samples.map(normalizeSourceLatencySample).filter(Boolean);
  if (samples.length !== body.samples.length) {
    return createBadRequestResponse('Invalid sample');
  }

  const servers = await getAllServers(env.DB, true);
  const validTargetIds = new Set(
    servers
      .map(server => String(server.id || ''))
      .filter(id => id && id !== String(auth.source.id))
  );
  if (samples.some(sample => !validTargetIds.has(sample.target_id))) {
    return createBadRequestResponse('Unknown target server');
  }

  const timestamp = Date.now();
  if (samples.length > 0) {
    await env.DB.batch(samples.map(sample => env.DB.prepare(`
      INSERT INTO source_latency (
        source_id, target_id, family, timestamp, latency_ms, loss_percent, method, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, family) DO UPDATE SET
        timestamp = excluded.timestamp,
        latency_ms = excluded.latency_ms,
        loss_percent = excluded.loss_percent,
        method = excluded.method,
        error = excluded.error
    `).bind(
      auth.source.id,
      sample.target_id,
      sample.family,
      timestamp,
      sample.latency_ms,
      sample.loss_percent,
      sample.method,
      sample.error
    )));
  }

  return createSuccessResponse({ success: true, accepted: samples.length, timestamp }, {
    'Cache-Control': 'no-store'
  });
}

export async function handleSourceLatencyAPI(request, env, sys) {
  await ensureSourceLatencyTable(env.DB);
  const isLoggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !isLoggedIn) return simpleAuthResponse();

  const url = new URL(request.url);
  const requestedSourceId = normalizeId(url.searchParams.get('source_id'));
  const configuredSourceId = normalizeId(sys.source_latency_source_id);
  let sourceId = requestedSourceId || configuredSourceId;

  if (!sourceId) {
    const latestSource = await env.DB.prepare(`
      SELECT source_id FROM source_latency ORDER BY timestamp DESC LIMIT 1
    `).first();
    sourceId = normalizeId(latestSource?.source_id);
  }
  if (!sourceId) {
    return createSuccessResponse({ source: null, interval_seconds: 60, targets: [] }, {
      'Cache-Control': 'no-store'
    });
  }

  const [servers, latestMetrics] = await Promise.all([
    getAllServers(env.DB, isLoggedIn),
    getLatestMetricsForAllServers(env.DB)
  ]);
  const source = servers.find(server => String(server.id) === sourceId)
    || await getServerDetail(env.DB, sourceId, isLoggedIn);
  if (!source) return createNotFoundResponse('Source server not found');

  const { results: rows = [] } = await env.DB.prepare(`
    SELECT target_id, family, timestamp, latency_ms, loss_percent, method, error
    FROM source_latency
    WHERE source_id = ?
  `).bind(sourceId).all();
  const sampleByTarget = new Map();
  for (const row of rows) {
    if (!sampleByTarget.has(row.target_id)) sampleByTarget.set(row.target_id, {});
    sampleByTarget.get(row.target_id)[row.family] = {
      timestamp: Number(row.timestamp) || 0,
      latency_ms: row.latency_ms === null ? null : Number(row.latency_ms),
      loss_percent: row.loss_percent === null ? null : Number(row.loss_percent),
      method: row.method || '',
      error: row.error || ''
    };
  }

  const targets = servers
    .filter(server => String(server.id) !== sourceId)
    .map(server => {
      const metrics = latestMetrics.get(server.id) || {};
      return {
        id: server.id,
        name: server.name || server.id,
        region: server.region || '',
        available: {
          ipv4: !!normalizeTargetAddress(metrics.ip_v4, 'ipv4'),
          ipv6: !!normalizeTargetAddress(metrics.ip_v6, 'ipv6')
        },
        families: sampleByTarget.get(server.id) || {}
      };
    });

  return createSuccessResponse({
    source: { id: source.id, name: source.name || source.id },
    interval_seconds: 60,
    targets
  }, { 'Cache-Control': 'no-store' });
}
