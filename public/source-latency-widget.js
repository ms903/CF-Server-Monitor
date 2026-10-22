(() => {
  if (window.__cfsmSourceLatencyWidget) return;
  window.__cfsmSourceLatencyWidget = true;

  const PANEL_ID = 'cfsm-source-latency';
  const STYLE_ID = 'cfsm-source-latency-style';
  const STALE_AFTER_MS = 180_000;
  const REFRESH_MS = 30_000;
  let latestData = null;
  let observerScheduled = false;

  let preferredLanguage = '';
  try {
    preferredLanguage = localStorage.getItem('language_preference') || '';
  } catch (_) {}
  const language = preferredLanguage === 'zh' || preferredLanguage === 'en' || preferredLanguage === 'es'
    ? preferredLanguage
    : (/^zh\b/i.test(navigator.language || '') ? 'zh' : (/^es\b/i.test(navigator.language || '') ? 'es' : 'en'));
  const messages = {
    zh: {
        kicker: '源端延迟', all: '全部服务器', measured: '已测',
        hint: '每 60 秒从 Home Server 测量；优先 ICMP，失败时回退 TCP/22。',
        loss: '丢包', waiting: '等待测量', noAddress: '无公网地址',
        unreachable: '不可达', stale: '数据已过期', seconds: '秒前', minutes: '分钟前'
      },
    en: {
        kicker: 'SOURCE LATENCY', all: 'All servers', measured: 'measured',
        hint: 'Measured from Home Server every 60 seconds; ICMP first, TCP/22 fallback.',
        loss: 'loss', waiting: 'Awaiting measurement', noAddress: 'No public address',
        unreachable: 'Unreachable', stale: 'Stale result', seconds: 's ago', minutes: 'm ago'
      },
    es: {
        kicker: 'LATENCIA DE ORIGEN', all: 'Todos los servidores', measured: 'medidos',
        hint: 'Medido desde Home Server cada 60 segundos; primero ICMP y luego TCP/22.',
        loss: 'pérdida', waiting: 'Esperando medición', noAddress: 'Sin dirección pública',
        unreachable: 'Inaccesible', stale: 'Resultado caducado', seconds: 's atrás', minutes: 'min atrás'
      }
  };
  const text = messages[language];

  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const isFresh = sample => {
    const timestamp = Number(sample?.timestamp) || 0;
    return timestamp > 0 && Date.now() - timestamp <= STALE_AFTER_MS;
  };

  const age = timestamp => {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
    return seconds < 60 ? `${seconds}${text.seconds}` : `${Math.floor(seconds / 60)}${text.minutes}`;
  };

  const statusClass = sample => {
    if (!isFresh(sample) || sample?.latency_ms == null) return 'is-bad';
    const latency = Number(sample.latency_ms);
    const loss = Number(sample.loss_percent) || 0;
    if (loss >= 20 || latency >= 300) return 'is-bad';
    if (loss > 0 || latency >= 150) return 'is-warn';
    return 'is-good';
  };

  const renderFamily = (target, family) => {
    const sample = target.families?.[family];
    if (!sample) {
      const message = target.available?.[family] === false ? text.noAddress : text.waiting;
      return `<div class="cfsm-sl-family"><span class="cfsm-sl-family-name">${family.toUpperCase()}</span><b class="cfsm-sl-empty">—</b><small>${message}</small></div>`;
    }
    const fresh = isFresh(sample);
    const reachable = fresh && sample.latency_ms != null;
    const latency = reachable
      ? `${Number(sample.latency_ms) < 10 ? Number(sample.latency_ms).toFixed(1) : Math.round(Number(sample.latency_ms))} ms`
      : text.unreachable;
    const loss = Number(sample.loss_percent);
    const lossText = Number.isFinite(loss) ? `${Number.isInteger(loss) ? loss : loss.toFixed(1)}%` : '—';
    const method = sample.method === 'tcp/22' ? 'TCP/22' : 'ICMP';
    const meta = fresh ? `${method} · ${text.loss} ${lossText} · ${age(sample.timestamp)}` : text.stale;
    return `<div class="cfsm-sl-family"><span class="cfsm-sl-family-name">${family.toUpperCase()}</span><b class="${statusClass(sample)}">${latency}</b><small title="${escapeHtml(sample.error || meta)}">${meta}</small></div>`;
  };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}{margin:0 0 16px;padding:16px;border:1px solid var(--hairline,var(--border));border-radius:16px;background:var(--surface-a,var(--surface));color:var(--text-primary);font-family:var(--font-sans,inherit)}
      .cfsm-sl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:13px}.cfsm-sl-kicker{color:var(--accent-strong,var(--status-info));font-size:10px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.cfsm-sl-title{margin:2px 0 0;font-size:17px;font-weight:800;line-height:1.35}.cfsm-sl-title i{color:var(--accent-strong,var(--status-info));font-style:normal}.cfsm-sl-hint{margin:3px 0 0;color:var(--text-tertiary);font-size:11px}.cfsm-sl-summary{display:flex;align-items:center;gap:7px;flex:none;color:var(--status-success);font-size:11px;font-weight:650}.cfsm-sl-summary:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 9px currentColor}
      .cfsm-sl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px}.cfsm-sl-card{min-width:0;padding:10px 11px;border:1px solid var(--hairline,var(--border));border-radius:12px;background:var(--surface-elev-a,var(--surface-elev))}.cfsm-sl-name{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.cfsm-sl-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.cfsm-sl-name span{color:var(--text-tertiary);font-size:9px}.cfsm-sl-families{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.cfsm-sl-family{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:2px 7px;min-width:0;padding:7px 8px;border:1px solid var(--border-subtle,var(--hairline));border-radius:9px;background:var(--surface-sunken,var(--surface-a))}.cfsm-sl-family-name{color:var(--text-tertiary);font-size:9px}.cfsm-sl-family b{justify-self:end;font-family:var(--font-numeric,var(--font-mono));font-size:13px;white-space:nowrap}.cfsm-sl-family small{grid-column:1/-1;overflow:hidden;color:var(--text-tertiary);font-size:9px;text-overflow:ellipsis;white-space:nowrap}.cfsm-sl-family .is-good{color:var(--latency-excellent,var(--status-success))}.cfsm-sl-family .is-warn{color:var(--latency-moderate,var(--status-warning))}.cfsm-sl-family .is-bad{color:var(--latency-critical,var(--status-error))}.cfsm-sl-family .cfsm-sl-empty{color:var(--text-tertiary)}
      @media(max-width:640px){#${PANEL_ID}{padding:13px}.cfsm-sl-head{flex-direction:column;gap:7px}.cfsm-sl-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  };

  const render = panel => {
    const targets = Array.isArray(latestData?.targets) ? latestData.targets : [];
    const measured = targets.filter(target => ['ipv4', 'ipv6'].some(family => isFresh(target.families?.[family]))).length;
    panel.innerHTML = `
      <div class="cfsm-sl-head">
        <div><div class="cfsm-sl-kicker">${text.kicker}</div><h2 class="cfsm-sl-title">${escapeHtml(latestData.source.name)} <i>→</i> ${text.all}</h2><p class="cfsm-sl-hint">${text.hint}</p></div>
        <div class="cfsm-sl-summary">${measured}/${targets.length} ${text.measured}</div>
      </div>
      <div class="cfsm-sl-grid">${targets.map(target => `
        <article class="cfsm-sl-card">
          <div class="cfsm-sl-name"><strong>${escapeHtml(target.name)}</strong><span>${escapeHtml(target.region || '')}</span></div>
          <div class="cfsm-sl-families">${renderFamily(target, 'ipv4')}${renderFamily(target, 'ipv6')}</div>
        </article>`).join('')}
      </div>`;
  };

  const mount = () => {
    observerScheduled = false;
    const existing = document.getElementById(PANEL_ID);
    const home = document.querySelector('.home-dashboard');
    if (!home || !latestData?.source) {
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

  const refresh = async () => {
    try {
      const response = await fetch('/api/source-latency', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data?.source || !Array.isArray(data.targets)) return;
      latestData = data;
      const panel = document.getElementById(PANEL_ID);
      if (panel) render(panel);
      else scheduleMount();
    } catch (_) {
      // Keep the previous values during a transient refresh failure.
    }
  };

  new MutationObserver(scheduleMount).observe(document.getElementById('root') || document.body, {
    childList: true,
    subtree: true
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  refresh();
  window.setInterval(refresh, REFRESH_MS);
})();
