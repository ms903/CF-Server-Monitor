(() => {
  if (window.__cfsmPathBandwidthWidget) return;
  window.__cfsmPathBandwidthWidget = true;

  const PANEL_ID = 'cfsm-path-bandwidth';
  const STYLE_ID = 'cfsm-path-bandwidth-style';
  const REFRESH_IDLE_MS = 30_000;
  const REFRESH_ACTIVE_MS = 3_000;
  let latestData = null;
  let refreshTimer = null;
  let observerScheduled = false;
  let actionPending = false;

  let preferredLanguage = '';
  try { preferredLanguage = localStorage.getItem('language_preference') || ''; } catch (_) {}
  const chinese = preferredLanguage === 'zh' || (!preferredLanguage && /^zh\b/i.test(navigator.language || ''));
  const t = chinese ? {
    kicker: '路径带宽', title: '各服务器 ↔ Home Server',
    hint: 'TCP 主动测速：每台服务器每天自动测一次；单方向固定传输 32 MiB。',
    all: '全部测速', test: '测速', queued: '等待测速', testing: '测速中', waiting: '等待探针',
    failed: '测速失败', agoSeconds: '秒前', agoMinutes: '分钟前', agoHours: '小时前',
    vpsToHome: 'VPS → Home', homeToVps: 'Home → VPS',
    measured: '已有结果', budget: '预计每月', noResult: '尚无结果'
  } : {
    kicker: 'PATH BANDWIDTH', title: 'Servers ↔ Home Server',
    hint: 'Active TCP test once per server per day; 32 MiB is transferred in each direction.',
    all: 'Test all', test: 'Test', queued: 'Queued', testing: 'Testing', waiting: 'Awaiting probe',
    failed: 'Test failed', agoSeconds: 's ago', agoMinutes: 'm ago', agoHours: 'h ago',
    vpsToHome: 'VPS → Home', homeToVps: 'Home → VPS',
    measured: 'measured', budget: 'Est. monthly', noResult: 'No result yet'
  };

  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const formatMbps = value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '—';
    const digits = number < 10 ? 2 : number < 100 ? 1 : 0;
    return `${number.toFixed(digits)} Mbps`;
  };

  const age = timestamp => {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
    if (seconds < 60) return `${seconds}${t.agoSeconds}`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}${t.agoMinutes}`;
    return `${Math.floor(seconds / 3600)}${t.agoHours}`;
  };

  const isActive = server => server.status === 'queued' || server.status === 'testing';
  const statusLabel = server => {
    if (server.status === 'queued') return t.queued;
    if (server.status === 'testing') return t.testing;
    if (server.status === 'error') return t.failed;
    if (server.tested_at) return age(server.tested_at);
    return server.status === 'waiting' ? t.waiting : t.noResult;
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{margin:0 0 16px;padding:16px;border:1px solid var(--hairline,var(--border));border-radius:16px;background:var(--surface-a,var(--surface));color:var(--text-primary);font-family:var(--font-sans,inherit)}
      .cfsm-bw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:13px}.cfsm-bw-kicker{color:var(--accent-strong,var(--status-info));font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.cfsm-bw-title{margin:2px 0 0;font-size:17px;font-weight:800;line-height:1.35}.cfsm-bw-hint{margin:3px 0 0;color:var(--text-tertiary);font-size:11px}.cfsm-bw-actions{display:flex;align-items:center;gap:10px;flex:none}.cfsm-bw-summary{color:var(--text-tertiary);font-size:10px;white-space:nowrap}.cfsm-bw-button{border:1px solid color-mix(in srgb,var(--accent-strong,var(--status-info)) 45%,transparent);border-radius:10px;background:color-mix(in srgb,var(--accent-strong,var(--status-info)) 13%,transparent);color:var(--accent-strong,var(--status-info));padding:7px 10px;font:inherit;font-size:11px;font-weight:700;cursor:pointer}.cfsm-bw-button:hover{background:color-mix(in srgb,var(--accent-strong,var(--status-info)) 20%,transparent)}.cfsm-bw-button:disabled{cursor:not-allowed;opacity:.48}
      .cfsm-bw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:9px}.cfsm-bw-card{position:relative;min-width:0;padding:11px;border:1px solid var(--hairline,var(--border));border-radius:12px;background:var(--surface-elev-a,var(--surface-elev));overflow:hidden}.cfsm-bw-card.is-active:after{content:"";position:absolute;inset:auto 0 0;height:2px;background:linear-gradient(90deg,transparent,var(--accent-strong,var(--status-info)),transparent);animation:cfsm-bw-scan 1.15s linear infinite}.cfsm-bw-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.cfsm-bw-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:750}.cfsm-bw-state{color:var(--text-tertiary);font-size:9px;white-space:nowrap}.cfsm-bw-state.is-active{color:var(--accent-strong,var(--status-info));font-weight:700}.cfsm-bw-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:9px}.cfsm-bw-value{padding:8px;border:1px solid var(--border-subtle,var(--hairline));border-radius:9px;background:var(--surface-sunken,var(--surface-a))}.cfsm-bw-value span{display:block;color:var(--text-tertiary);font-size:9px}.cfsm-bw-value b{display:block;margin-top:3px;font-family:var(--font-numeric,var(--font-mono));font-size:14px;white-space:nowrap}.cfsm-bw-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;min-height:23px}.cfsm-bw-error{overflow:hidden;color:var(--status-error);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.cfsm-bw-card .cfsm-bw-button{padding:4px 8px;font-size:9px}.cfsm-bw-good{color:var(--latency-excellent,var(--status-success))}
      @keyframes cfsm-bw-scan{from{transform:translateX(-55%)}to{transform:translateX(55%)}}@media(max-width:640px){#${PANEL_ID}{padding:13px}.cfsm-bw-head{flex-direction:column;gap:8px}.cfsm-bw-actions{width:100%;justify-content:space-between}.cfsm-bw-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  };

  const render = panel => {
    const servers = Array.isArray(latestData?.servers) ? latestData.servers : [];
    const measured = servers.filter(server => Number(server.tested_at) > 0 && server.status === 'ok').length;
    const monthlyGiB = Number(latestData?.estimated_monthly_bytes || 0) / 1024 / 1024 / 1024;
    panel.innerHTML = `
      <div class="cfsm-bw-head">
        <div><div class="cfsm-bw-kicker">${t.kicker}</div><h2 class="cfsm-bw-title">${t.title}</h2><p class="cfsm-bw-hint">${t.hint}</p></div>
        <div class="cfsm-bw-actions"><span class="cfsm-bw-summary">${measured}/${servers.length} ${t.measured} · ${t.budget} ${monthlyGiB.toFixed(1)} GiB</span>${latestData?.can_trigger ? `<button class="cfsm-bw-button" data-trigger="all" ${actionPending ? 'disabled' : ''}>${t.all}</button>` : ''}</div>
      </div>
      <div class="cfsm-bw-grid">${servers.map(server => `
        <article class="cfsm-bw-card ${isActive(server) ? 'is-active' : ''}">
          <div class="cfsm-bw-card-head"><strong class="cfsm-bw-name">${escapeHtml(server.name)}</strong><span class="cfsm-bw-state ${isActive(server) ? 'is-active' : ''}">${statusLabel(server)}</span></div>
          <div class="cfsm-bw-values">
            <div class="cfsm-bw-value"><span>${t.vpsToHome}</span><b class="cfsm-bw-good">${formatMbps(server.vps_to_home_mbps)}</b></div>
            <div class="cfsm-bw-value"><span>${t.homeToVps}</span><b class="cfsm-bw-good">${formatMbps(server.home_to_vps_mbps)}</b></div>
          </div>
          <div class="cfsm-bw-foot"><span class="cfsm-bw-error" title="${escapeHtml(server.error || '')}">${escapeHtml(server.error || '')}</span>${latestData?.can_trigger ? `<button class="cfsm-bw-button" data-trigger="${escapeHtml(server.id)}" ${actionPending || isActive(server) ? 'disabled' : ''}>${t.test}</button>` : ''}</div>
        </article>`).join('')}
      </div>`;
    panel.querySelectorAll('[data-trigger]').forEach(button => {
      button.addEventListener('click', () => trigger(button.dataset.trigger === 'all' ? '' : button.dataset.trigger));
    });
  };

  const mount = () => {
    observerScheduled = false;
    const existing = document.getElementById(PANEL_ID);
    const home = document.querySelector('.home-dashboard');
    if (!home || !latestData?.target) {
      if (existing && !home) existing.remove();
      return;
    }
    ensureStyle();
    if (existing) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.setAttribute('aria-live', 'polite');
    const overview = home.querySelector('.home-overview');
    if (overview) overview.insertAdjacentElement('afterend', panel);
    else {
      const before = home.querySelector('.home-controls-bar, .home-region-bar, .node-list-scroll');
      before ? before.insertAdjacentElement('beforebegin', panel) : home.appendChild(panel);
    }
    render(panel);
  };

  const scheduleMount = () => {
    if (observerScheduled) return;
    observerScheduled = true;
    queueMicrotask(mount);
  };

  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer);
    const active = latestData?.servers?.some(isActive);
    refreshTimer = window.setTimeout(refresh, active ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS);
  };

  const refresh = async () => {
    try {
      const response = await fetch('/api/path-bandwidth', { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (!data?.target || !Array.isArray(data.servers)) return;
      latestData = data;
      const panel = document.getElementById(PANEL_ID);
      if (panel) render(panel); else scheduleMount();
    } catch (_) {
      // Keep the last successful result visible during a transient failure.
    } finally {
      scheduleRefresh();
    }
  };

  const trigger = async serverId => {
    if (actionPending) return;
    actionPending = true;
    const panel = document.getElementById(PANEL_ID);
    if (panel) render(panel);
    try {
      const response = await fetch('/api/path-bandwidth/trigger', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: serverId })
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
