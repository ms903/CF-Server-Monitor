(() => {
  if (window.__cfsmFamilyPathWidget) return;
  window.__cfsmFamilyPathWidget = true;

  const PANEL_ID = 'cfsm-family-path';
  const STYLE_ID = 'cfsm-family-path-style';
  const REFRESH_IDLE_MS = 30_000;
  const REFRESH_ACTIVE_MS = 3_000;
  let latestData = null;
  let historyData = null;
  let historyKey = '';
  let selectedServer = '';
  let selectedFamily = '';
  let selectedHours = 168;
  let refreshTimer = null;
  let observerScheduled = false;
  let actionPending = false;
  let historyLoading = false;

  let preferredLanguage = '';
  try { preferredLanguage = localStorage.getItem('language_preference') || ''; } catch (_) {}
  const chinese = preferredLanguage === 'zh' || (!preferredLanguage && /^zh\b/i.test(navigator.language || ''));
  const t = chinese ? {
    kicker: '公网路径', title: 'Home Server → 各服务器',
    hint: 'IPv4 / IPv6 独立探测：延迟每分钟更新，双向带宽每 6 小时更新。',
    all: '全部测速', test: '测速', queued: '排队中', testing: '测速中', waiting: '等待数据',
    failed: '失败', latency: '延迟', loss: '丢包', vpsToHome: 'VPS → Home', homeToVps: 'Home → VPS',
    speedHistory: '测速历史', last24h: '24 小时', last7d: '7 天', last30d: '30 天',
    noHistory: '还没有该地址族的测速历史', points: '次测速', agoS: '秒前', agoM: '分钟前', agoH: '小时前', agoD: '天前',
    p95: 'p95', jitter: '抖动', measured: '已测路径', budget: '月流量上限约', address: '地址'
  } : {
    kicker: 'PUBLIC PATHS', title: 'Home Server → Servers',
    hint: 'IPv4 and IPv6 are measured independently: latency every minute, bidirectional speed every 6 hours.',
    all: 'Test all', test: 'Test', queued: 'Queued', testing: 'Testing', waiting: 'Waiting',
    failed: 'Failed', latency: 'Latency', loss: 'Loss', vpsToHome: 'VPS → Home', homeToVps: 'Home → VPS',
    speedHistory: 'Speed history', last24h: '24 hours', last7d: '7 days', last30d: '30 days',
    noHistory: 'No speed-test history for this address family yet', points: 'tests', agoS: 's ago', agoM: 'm ago', agoH: 'h ago', agoD: 'd ago',
    p95: 'p95', jitter: 'Jitter', measured: 'measured paths', budget: 'monthly cap ≈', address: 'Address'
  };

  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const familyLabel = value => value === 'ipv6' ? 'IPv6' : 'IPv4';
  const formatMbps = value => {
    const n = finite(value);
    if (n === null || n < 0) return '—';
    return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)} Mbps`;
  };
  const formatMs = value => {
    const n = finite(value);
    if (n === null || n < 0) return '—';
    return `${n < 10 ? n.toFixed(1) : n.toFixed(0)} ms`;
  };
  const age = value => {
    const stamp = Number(value || 0);
    if (!stamp) return t.waiting;
    const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
    if (seconds < 60) return `${seconds}${t.agoS}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}${t.agoM}`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}${t.agoH}`;
    return `${Math.floor(seconds / 86400)}${t.agoD}`;
  };
  const isActive = path => path?.bandwidth_status === 'queued' || path?.bandwidth_status === 'testing';
  const stateLabel = path => {
    if (path.bandwidth_status === 'queued') return t.queued;
    if (path.bandwidth_status === 'testing') return t.testing;
    if (path.bandwidth_status === 'error') return t.failed;
    return age(path.bandwidth_at);
  };
  const paths = () => Array.isArray(latestData?.paths) ? latestData.paths : [];
  const groups = () => {
    const map = new Map();
    for (const path of paths()) {
      if (!map.has(path.server_id)) map.set(path.server_id, { id: path.server_id, name: path.server_name, region: path.region, paths: [] });
      map.get(path.server_id).paths.push(path);
    }
    return [...map.values()].map(group => ({ ...group, paths: group.paths.sort((a, b) => a.family.localeCompare(b.family)) }));
  };
  const currentPath = () => paths().find(path => String(path.server_id) === String(selectedServer) && path.family === selectedFamily) || null;

  const ensureSelection = () => {
    const all = paths();
    if (!all.length) return;
    if (!currentPath()) {
      const first = all.find(path => path.family === 'ipv6' && path.bandwidth_status === 'ok' && Number(path.bandwidth_at) > 0)
        || all.find(path => path.family === 'ipv6' && Number(path.bandwidth_at) > 0)
        || all.find(path => path.family === 'ipv6')
        || all[0];
      selectedServer = String(first.server_id);
      selectedFamily = first.family;
      historyData = null;
      historyKey = '';
    }
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{margin:0 0 18px;padding:17px;border:1px solid var(--hairline,var(--border));border-radius:16px;background:var(--surface-a,var(--surface));color:var(--text-primary);font-family:var(--font-sans,inherit)}
      .cfp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:13px}.cfp-kicker{color:var(--accent-strong,var(--status-info));font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.cfp-title{margin:2px 0 0;font-size:18px;font-weight:820;line-height:1.35}.cfp-hint{margin:4px 0 0;color:var(--text-tertiary);font-size:11px}.cfp-actions{display:flex;align-items:center;gap:9px;flex:none}.cfp-summary{color:var(--text-tertiary);font-size:10px;white-space:nowrap}.cfp-button{border:1px solid color-mix(in srgb,var(--accent-strong,var(--status-info)) 48%,transparent);border-radius:9px;background:color-mix(in srgb,var(--accent-strong,var(--status-info)) 12%,transparent);color:var(--accent-strong,var(--status-info));padding:6px 9px;font:inherit;font-size:10px;font-weight:750;cursor:pointer}.cfp-button:hover{background:color-mix(in srgb,var(--accent-strong,var(--status-info)) 20%,transparent)}.cfp-button:disabled{cursor:not-allowed;opacity:.45}
      .cfp-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.cfp-card{min-width:0;padding:11px;border:1px solid var(--hairline,var(--border));border-radius:12px;background:var(--surface-elev-a,var(--surface-elev))}.cfp-card-title{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}.cfp-card-title strong{font-size:13px}.cfp-card-title span{overflow:hidden;color:var(--text-tertiary);font-family:var(--font-numeric,var(--font-mono));font-size:9px;text-overflow:ellipsis;white-space:nowrap}
      .cfp-family{position:relative;display:grid;grid-template-columns:52px minmax(82px,.8fr) minmax(96px,1fr) auto;align-items:center;gap:8px;min-height:54px;padding:7px 8px;border:1px solid var(--border-subtle,var(--hairline));border-radius:9px;background:var(--surface-sunken,var(--surface-a));cursor:pointer;overflow:hidden}.cfp-family+.cfp-family{margin-top:6px}.cfp-family.is-selected{border-color:color-mix(in srgb,var(--accent-strong,var(--status-info)) 58%,transparent);box-shadow:inset 2px 0 var(--accent-strong,var(--status-info))}.cfp-family.is-active:after{content:"";position:absolute;inset:auto 0 0;height:2px;background:linear-gradient(90deg,transparent,var(--accent-strong,var(--status-info)),transparent);animation:cfp-scan 1.15s linear infinite}.cfp-family-tag{display:flex;flex-direction:column;gap:2px}.cfp-family-tag b{font-size:11px}.cfp-family-tag small{overflow:hidden;color:var(--text-tertiary);font-family:var(--font-numeric,var(--font-mono));font-size:8px;text-overflow:ellipsis;white-space:nowrap;max-width:55px}.cfp-latency span,.cfp-speed span{display:block;color:var(--text-tertiary);font-size:8px}.cfp-latency b,.cfp-speed b{display:block;margin-top:2px;font-family:var(--font-numeric,var(--font-mono));font-size:12px;white-space:nowrap}.cfp-latency small,.cfp-speed small{display:block;margin-top:2px;color:var(--text-tertiary);font-size:8px;white-space:nowrap}.cfp-row-actions{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.cfp-state{color:var(--text-tertiary);font-size:8px;white-space:nowrap}.cfp-state.is-error{color:var(--status-error)}.cfp-state.is-active{color:var(--accent-strong,var(--status-info));font-weight:750}.cfp-row-actions .cfp-button{padding:4px 7px;font-size:8px}.cfp-error{margin:5px 1px 0;overflow:hidden;color:var(--status-error);font-size:8px;text-overflow:ellipsis;white-space:nowrap}
      .cfp-history{margin-top:12px;padding-top:12px;border-top:1px solid var(--hairline,var(--border))}.cfp-history-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.cfp-history-title{font-size:13px;font-weight:780}.cfp-selects{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.cfp-select{height:30px;min-width:92px;border:1px solid var(--hairline,var(--border));border-radius:8px;background:var(--surface-sunken,var(--surface-a));color:var(--text-primary);padding:0 24px 0 8px;font:inherit;font-size:10px}.cfp-chart-wrap{position:relative;height:190px;border:1px solid var(--border-subtle,var(--hairline));border-radius:10px;background:var(--surface-sunken,var(--surface-a));overflow:hidden}.cfp-chart{display:block;width:100%;height:100%}.cfp-chart text{fill:var(--text-tertiary);font:9px var(--font-numeric,var(--font-mono))}.cfp-grid-line{stroke:var(--hairline,var(--border));stroke-width:1;vector-effect:non-scaling-stroke}.cfp-line-down{fill:none;stroke:var(--accent-strong,var(--status-info));stroke-width:1.5;vector-effect:non-scaling-stroke}.cfp-line-up{fill:none;stroke:var(--status-success,#57db99);stroke-width:1.5;vector-effect:non-scaling-stroke}.cfp-dot-down{fill:var(--accent-strong,var(--status-info))}.cfp-dot-up{fill:var(--status-success,#57db99)}.cfp-legend{position:absolute;top:8px;right:10px;display:flex;gap:12px;color:var(--text-tertiary);font-size:9px}.cfp-legend i{display:inline-block;width:12px;height:2px;margin:0 5px 3px 0}.cfp-legend .down{background:var(--accent-strong,var(--status-info))}.cfp-legend .up{background:var(--status-success,#57db99)}.cfp-empty{display:grid;height:100%;place-items:center;color:var(--text-tertiary);font-size:10px}.cfp-history-meta{margin-top:6px;color:var(--text-tertiary);font-size:9px;text-align:right}
      @keyframes cfp-scan{from{transform:translateX(-55%)}to{transform:translateX(55%)}}@media(max-width:1200px){.cfp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){#${PANEL_ID}{padding:13px}.cfp-head,.cfp-history-head{align-items:stretch;flex-direction:column}.cfp-actions{justify-content:space-between}.cfp-summary{white-space:normal}.cfp-grid{grid-template-columns:1fr}.cfp-family{grid-template-columns:46px minmax(70px,.75fr) minmax(88px,1fr) auto}.cfp-selects{justify-content:flex-start}.cfp-chart-wrap{height:170px}}
    `;
    document.head.appendChild(style);
  };

  const chart = () => {
    if (historyLoading) return `<div class="cfp-empty">${escapeHtml(t.testing)}…</div>`;
    const raw = Array.isArray(historyData?.points) ? historyData.points : [];
    const points = raw.filter(point => point.status === 'ok' && finite(point.vps_to_home_mbps) !== null && finite(point.home_to_vps_mbps) !== null);
    if (!points.length) return `<div class="cfp-empty">${escapeHtml(t.noHistory)}</div>`;
    const W = 900, H = 190, L = 45, R = 16, T = 23, B = 28;
    const values = points.flatMap(point => [Number(point.vps_to_home_mbps), Number(point.home_to_vps_mbps)]);
    const maxRaw = Math.max(1, ...values);
    const step = 10 ** Math.floor(Math.log10(maxRaw));
    const maxY = Math.ceil(maxRaw / step) * step;
    const minX = Number(points[0].observed_at), maxX = Math.max(minX + 1, Number(points[points.length - 1].observed_at));
    const x = stamp => L + ((Number(stamp) - minX) / (maxX - minX)) * (W - L - R);
    const y = value => T + (1 - Number(value) / maxY) * (H - T - B);
    const poly = key => points.map(point => `${x(point.observed_at).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
    const formatTime = stamp => new Intl.DateTimeFormat(chinese ? 'zh-CN' : undefined, selectedHours <= 24
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'numeric', day: 'numeric', hour: '2-digit' }).format(new Date(stamp));
    const ticks = [0, .5, 1];
    const circles = (key, cls) => points.map(point => `<circle class="${cls}" cx="${x(point.observed_at).toFixed(1)}" cy="${y(point[key]).toFixed(1)}" r="2.3"><title>${escapeHtml(formatTime(point.observed_at))} · ${escapeHtml(formatMbps(point[key]))}</title></circle>`).join('');
    return `<div class="cfp-legend"><span><i class="down"></i>${t.vpsToHome}</span><span><i class="up"></i>${t.homeToVps}</span></div><svg class="cfp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t.speedHistory)}">
      ${ticks.map(frac => `<line class="cfp-grid-line" x1="${L}" x2="${W - R}" y1="${y(maxY * frac)}" y2="${y(maxY * frac)}"/><text x="${L - 7}" y="${y(maxY * frac) + 3}" text-anchor="end">${Math.round(maxY * frac)}</text>`).join('')}
      <text x="8" y="12">Mbps</text>
      <polyline class="cfp-line-down" points="${poly('vps_to_home_mbps')}"/>${circles('vps_to_home_mbps', 'cfp-dot-down')}
      <polyline class="cfp-line-up" points="${poly('home_to_vps_mbps')}"/>${circles('home_to_vps_mbps', 'cfp-dot-up')}
      <text x="${L}" y="${H - 8}" text-anchor="start">${escapeHtml(formatTime(minX))}</text><text x="${W - R}" y="${H - 8}" text-anchor="end">${escapeHtml(formatTime(maxX))}</text>
    </svg>`;
  };

  const familyRow = path => {
    const error = path.bandwidth_error || path.latency_error || '';
    const active = isActive(path);
    const selected = String(path.server_id) === String(selectedServer) && path.family === selectedFamily;
    const latencySub = finite(path.loss_percent) === null ? t.waiting : `${t.loss} ${Number(path.loss_percent).toFixed(1)}% · ${t.p95} ${formatMs(path.rtt_p95_ms)}`;
    return `<div class="cfp-family ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''}" data-select-server="${escapeHtml(path.server_id)}" data-select-family="${path.family}">
      <div class="cfp-family-tag"><b>${familyLabel(path.family)}</b><small title="${escapeHtml(path.ip_address)}">${escapeHtml(path.ip_address)}</small></div>
      <div class="cfp-latency"><span>${t.latency}</span><b>${formatMs(path.rtt_median_ms)}</b><small>${latencySub}</small></div>
      <div class="cfp-speed"><span>${t.vpsToHome} / ${t.homeToVps}</span><b>${formatMbps(path.vps_to_home_mbps)} / ${formatMbps(path.home_to_vps_mbps)}</b><small>${path.bandwidth_at ? age(path.bandwidth_at) : t.waiting}</small></div>
      <div class="cfp-row-actions"><span class="cfp-state ${active ? 'is-active' : path.bandwidth_status === 'error' ? 'is-error' : ''}">${stateLabel(path)}</span>${latestData?.can_trigger ? `<button class="cfp-button" data-trigger-server="${escapeHtml(path.server_id)}" data-trigger-family="${path.family}" ${actionPending || active ? 'disabled' : ''}>${t.test}</button>` : ''}</div>
      ${error ? `<div class="cfp-error" style="grid-column:1/-1" title="${escapeHtml(error)}">${escapeHtml(error)}</div>` : ''}
    </div>`;
  };

  const render = panel => {
    ensureSelection();
    const grouped = groups();
    const measured = paths().filter(path => Number(path.bandwidth_at) > 0 && path.bandwidth_status === 'ok').length;
    const monthlyGiB = Number(latestData?.estimated_monthly_bytes || 0) / 1024 / 1024 / 1024;
    panel.innerHTML = `<div class="cfp-head"><div><div class="cfp-kicker">${t.kicker}</div><h2 class="cfp-title">${t.title}</h2><p class="cfp-hint">${t.hint}</p></div><div class="cfp-actions"><span class="cfp-summary">${measured}/${paths().length} ${t.measured} · ${t.budget} ${monthlyGiB.toFixed(1)} GiB</span>${latestData?.can_trigger ? `<button class="cfp-button" data-trigger-all ${actionPending ? 'disabled' : ''}>${t.all}</button>` : ''}</div></div>
      <div class="cfp-grid">${grouped.map(group => `<article class="cfp-card"><div class="cfp-card-title"><strong>${escapeHtml(group.name)}</strong><span>${escapeHtml(group.region || '')}</span></div>${group.paths.map(familyRow).join('')}</article>`).join('')}</div>
      <section class="cfp-history"><div class="cfp-history-head"><strong class="cfp-history-title">${t.speedHistory}</strong><div class="cfp-selects">
        <select class="cfp-select" data-history-server aria-label="Server">${grouped.map(group => `<option value="${escapeHtml(group.id)}" ${String(group.id) === String(selectedServer) ? 'selected' : ''}>${escapeHtml(group.name)}</option>`).join('')}</select>
        <select class="cfp-select" data-history-family aria-label="Address family">${(grouped.find(group => String(group.id) === String(selectedServer))?.paths || []).map(path => `<option value="${path.family}" ${path.family === selectedFamily ? 'selected' : ''}>${familyLabel(path.family)}</option>`).join('')}</select>
        <select class="cfp-select" data-history-hours aria-label="Range"><option value="24" ${selectedHours === 24 ? 'selected' : ''}>${t.last24h}</option><option value="168" ${selectedHours === 168 ? 'selected' : ''}>${t.last7d}</option><option value="720" ${selectedHours === 720 ? 'selected' : ''}>${t.last30d}</option></select>
      </div></div><div class="cfp-chart-wrap">${chart()}</div><div class="cfp-history-meta">${(historyData?.points || []).filter(point => point.status === 'ok').length} ${t.points}</div></section>`;

    panel.querySelector('[data-trigger-all]')?.addEventListener('click', event => { event.stopPropagation(); trigger('', ''); });
    panel.querySelectorAll('[data-trigger-server]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation(); trigger(button.dataset.triggerServer, button.dataset.triggerFamily);
    }));
    panel.querySelectorAll('[data-select-server]').forEach(row => row.addEventListener('click', () => selectPath(row.dataset.selectServer, row.dataset.selectFamily)));
    panel.querySelector('[data-history-server]')?.addEventListener('change', event => {
      const group = grouped.find(item => String(item.id) === String(event.target.value));
      selectPath(event.target.value, group?.paths?.[0]?.family || 'ipv4');
    });
    panel.querySelector('[data-history-family]')?.addEventListener('change', event => selectPath(selectedServer, event.target.value));
    panel.querySelector('[data-history-hours]')?.addEventListener('change', event => {
      selectedHours = Number(event.target.value); historyKey = ''; loadHistory();
    });
  };

  const mount = () => {
    observerScheduled = false;
    const existing = document.getElementById(PANEL_ID);
    const home = document.querySelector('.home-dashboard');
    if (!home || !latestData) { if (existing && !home) existing.remove(); return; }
    ensureStyle();
    if (existing) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-live', 'polite');
    const overview = home.querySelector('.home-overview');
    if (overview) overview.insertAdjacentElement('afterend', panel);
    else {
      const before = home.querySelector('.home-controls-bar, .home-region-bar, .node-list-scroll');
      before ? before.insertAdjacentElement('beforebegin', panel) : home.prepend(panel);
    }
    render(panel);
  };
  const scheduleMount = () => {
    if (observerScheduled) return;
    observerScheduled = true;
    queueMicrotask(mount);
  };
  const selectPath = (serverId, family) => {
    selectedServer = String(serverId);
    selectedFamily = family;
    historyKey = '';
    historyData = null;
    const panel = document.getElementById(PANEL_ID);
    if (panel) render(panel);
    loadHistory();
  };
  const loadHistory = async () => {
    ensureSelection();
    if (!selectedServer || !selectedFamily) return;
    const key = `${selectedServer}:${selectedFamily}:${selectedHours}`;
    if (historyLoading || historyKey === key) return;
    historyLoading = true;
    const panel = document.getElementById(PANEL_ID);
    if (panel) render(panel);
    try {
      const response = await fetch(`/api/family-path/history?server_id=${encodeURIComponent(selectedServer)}&family=${encodeURIComponent(selectedFamily)}&hours=${selectedHours}`, { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      historyData = await response.json();
      historyKey = key;
    } catch (_) {
    } finally {
      historyLoading = false;
      const currentPanel = document.getElementById(PANEL_ID);
      if (currentPanel && latestData) render(currentPanel);
    }
  };
  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, paths().some(isActive) ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS);
  };
  const refresh = async () => {
    try {
      const response = await fetch('/api/family-path', { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data?.paths)) return;
      latestData = data;
      ensureSelection();
      const panel = document.getElementById(PANEL_ID);
      if (panel) render(panel); else scheduleMount();
      await loadHistory();
    } catch (_) {
    } finally { scheduleRefresh(); }
  };
  const trigger = async (serverId, family) => {
    if (actionPending) return;
    actionPending = true;
    const panel = document.getElementById(PANEL_ID);
    if (panel) render(panel);
    try {
      const response = await fetch('/api/family-path/trigger', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId, family })
      });
      if (response.ok) await refresh();
    } finally {
      actionPending = false;
      if (panel && latestData) render(panel);
    }
  };

  new MutationObserver(scheduleMount).observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
})();
