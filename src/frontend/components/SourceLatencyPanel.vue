<template>
  <section v-if="data?.source" class="source-latency-panel" aria-live="polite">
    <div class="source-latency-header">
      <div>
        <div class="source-latency-kicker">{{ trans.homeLatencyKicker }}</div>
        <h2>{{ data.source.name }} <span aria-hidden="true">→</span> {{ trans.allServers }}</h2>
        <p>{{ trans.homeLatencyHint }}</p>
      </div>
      <div class="source-latency-summary" :class="{ pending: measuredCount === 0 }">
        <span class="source-latency-dot"></span>
        <span v-if="loading">{{ trans.loading }}</span>
        <span v-else>{{ measuredCount }}/{{ data.targets.length }} {{ trans.measured }}</span>
      </div>
    </div>

    <div v-if="data.targets.length" class="source-latency-grid">
      <article v-for="target in data.targets" :key="target.id" class="source-latency-card">
        <div class="source-latency-name-row">
          <strong>{{ target.name }}</strong>
          <span v-if="target.region" class="source-latency-region">{{ target.region }}</span>
        </div>
        <div class="source-latency-families">
          <div v-for="family in families" :key="family" class="source-latency-family">
            <span class="source-latency-family-label">{{ family.toUpperCase() }}</span>
            <template v-if="target.families?.[family]">
              <span
                class="source-latency-value"
                :class="latencyClass(target.families[family])"
                :title="sampleTitle(target.families[family])"
              >
                {{ formatLatency(target.families[family]) }}
              </span>
              <span class="source-latency-meta">
                {{ formatMeta(target.families[family]) }}
              </span>
            </template>
            <template v-else>
              <span class="source-latency-value unavailable">—</span>
              <span class="source-latency-meta">
                {{ target.available?.[family] === false ? trans.noAddress : trans.awaitingMeasurement }}
              </span>
            </template>
          </div>
        </div>
      </article>
    </div>
    <div v-else class="source-latency-empty">{{ trans.awaitingMeasurement }}</div>
  </section>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  data: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  now: { type: Number, default: () => Date.now() },
  trans: { type: Object, required: true }
})

const families = ['ipv4', 'ipv6']
const STALE_AFTER_MS = 180_000

const isFresh = (sample) => {
  const timestamp = Number(sample?.timestamp) || 0
  return timestamp > 0 && props.now - timestamp <= STALE_AFTER_MS
}

const measuredCount = computed(() => (props.data?.targets || []).filter(target =>
  families.some(family => isFresh(target.families?.[family]))
).length)

const formatLatency = (sample) => {
  if (!isFresh(sample) || sample?.latency_ms === null || sample?.latency_ms === undefined) {
    return props.trans.unreachable
  }
  const latency = Number(sample.latency_ms)
  return `${latency < 10 ? latency.toFixed(1) : Math.round(latency)} ms`
}

const latencyClass = (sample) => {
  if (!isFresh(sample) || sample?.latency_ms === null || sample?.latency_ms === undefined) return 'unreachable'
  const latency = Number(sample.latency_ms)
  const loss = Number(sample.loss_percent) || 0
  if (loss >= 20 || latency >= 300) return 'poor'
  if (loss > 0 || latency >= 150) return 'warning'
  return 'healthy'
}

const formatAge = (timestamp) => {
  const seconds = Math.max(0, Math.floor((props.now - Number(timestamp || 0)) / 1000))
  if (seconds < 60) return `${seconds}${props.trans.secondsShort}`
  return `${Math.floor(seconds / 60)}${props.trans.minutesShort}`
}

const formatMeta = (sample) => {
  if (!isFresh(sample)) return props.trans.staleMeasurement
  const method = sample.method === 'tcp/22' ? 'TCP/22' : 'ICMP'
  const loss = Number(sample.loss_percent)
  const lossText = Number.isFinite(loss) ? `${loss.toFixed(loss % 1 ? 1 : 0)}%` : '—'
  return `${method} · ${props.trans.packetLoss} ${lossText} · ${formatAge(sample.timestamp)}`
}

const sampleTitle = (sample) => sample?.error || formatMeta(sample)
</script>

<style scoped>
.source-latency-panel {
  margin: 14px 0 18px;
  padding: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.source-latency-header,
.source-latency-name-row,
.source-latency-summary,
.source-latency-family {
  display: flex;
  align-items: center;
}

.source-latency-header {
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 14px;
}

.source-latency-kicker {
  margin-bottom: 2px;
  color: var(--accent-cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}

h2 {
  color: var(--text-primary);
  font-size: 18px;
  line-height: 1.35;
}

h2 span {
  color: var(--accent-cyan);
}

p {
  margin-top: 3px;
  color: var(--text-secondary);
  font-size: 11px;
}

.source-latency-summary {
  flex: 0 0 auto;
  gap: 7px;
  color: var(--accent-green);
  font-size: 11px;
}

.source-latency-summary.pending {
  color: var(--text-secondary);
}

.source-latency-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}

.source-latency-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 9px;
}

.source-latency-card {
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg-card) 88%, transparent);
}

.source-latency-name-row {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
}

.source-latency-name-row strong {
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-latency-region {
  color: var(--text-secondary);
  font-size: 9px;
}

.source-latency-families {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.source-latency-family {
  min-width: 0;
  flex-wrap: wrap;
  gap: 3px 7px;
  padding: 7px 8px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--input-bg);
}

.source-latency-family-label {
  color: var(--text-secondary);
  font-size: 9px;
}

.source-latency-value {
  margin-left: auto;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}

.source-latency-value.healthy { color: var(--accent-green); }
.source-latency-value.warning { color: var(--accent-yellow); }
.source-latency-value.poor,
.source-latency-value.unreachable { color: var(--accent-red); }
.source-latency-value.unavailable { color: var(--text-secondary); }

.source-latency-meta {
  width: 100%;
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-latency-empty {
  padding: 18px;
  color: var(--text-secondary);
  text-align: center;
}

@media (max-width: 640px) {
  .source-latency-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .source-latency-grid {
    grid-template-columns: 1fr;
  }
}
</style>
