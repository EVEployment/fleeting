<template>
  <div class="focus-panel" :class="{ 'alert-pulse': alertActive }">
    <div class="panel-header">
      <span class="panel-title">{{ t('focus.title') }}</span>
      <span class="coverage-badge" :class="{ 'low-coverage': result.coverage < 0.6 }">
        <span v-if="result.coverage < 0.6" class="low-tag">{{ t('focus.lowCoverage') }}</span>
        {{ t('focus.coverage') }}: {{ pct(result.coverage) }}
      </span>
    </div>

    <div class="target-rows">
      <div
        v-for="(row, idx) in displayRows"
        :key="row.targetName"
        class="target-row"
      >
        <span class="dot" :class="idx === 0 ? 'dot-focus' : 'dot-other'">●</span>
        <span class="target-name">{{ row.targetName }}</span>
        <div class="bar-wrap">
          <div
            class="bar-fill"
            :class="idx === 0 ? 'bar-focus' : 'bar-other'"
            :style="{ width: `${row.share * 100}%` }"
          />
        </div>
        <span class="pct-label">{{ pct(row.share) }}</span>
        <span class="pilot-count">{{ row.pilotCount }}p</span>
      </div>

      <div v-if="othersEntry" class="target-row others-row">
        <span class="dot dot-others">○</span>
        <span class="target-name">{{ t('focus.others') }}</span>
        <div class="bar-wrap">
          <div
            class="bar-fill bar-others"
            :style="{ width: `${othersEntry.share * 100}%` }"
          />
        </div>
        <span class="pct-label">{{ pct(othersEntry.share) }}</span>
        <span class="pilot-count">{{ othersEntry.pilotCount }}p</span>
      </div>
    </div>

    <div class="panel-footer">
      <span>{{ t('focus.focusShare') }}: {{ pct(result.focusShare) }}</span>
      <span class="sep">|</span>
      <span>{{ t('focus.effTargets') }}: {{ result.effectiveTargets.toFixed(1) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTranslation } from 'i18next-vue';
import { computeFocus } from '@/lib/focusAnalysis';

const { t } = useTranslation();

const props = defineProps<{
  breakdown: Array<{ targetName?: string; amount: number; pilotName?: string; [key: string]: unknown }>;
  totalDpsOut: number;
  alertActive?: boolean;
}>();

const MAX_ROWS = 5;

const result = computed(() => computeFocus(props.breakdown, props.totalDpsOut));

const displayRows = computed(() => result.value.targetBreakdown.slice(0, MAX_ROWS));

const othersEntry = computed(() => {
  const rest = result.value.targetBreakdown.slice(MAX_ROWS);
  if (rest.length === 0) return null;
  return {
    targetName: '(others)',
    totalAmount: rest.reduce((s, r) => s + r.totalAmount, 0),
    pilotCount: rest.reduce((s, r) => s + r.pilotCount, 0),
    share: rest.reduce((s, r) => s + r.share, 0),
  };
});

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
</script>

<style scoped>
.focus-panel {
  background: #141928;
  border: 1px solid #2a3050;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 260px;
}

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.panel-title {
  font-size: 0.95rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #c8a84b;
}

.coverage-badge {
  font-size: 0.82rem;
  color: #8a9cc0;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.low-tag {
  background: #7a5c00;
  color: #f0c040;
  font-size: 0.72rem;
  padding: 0 0.35rem;
  border-radius: 3px;
  font-weight: 600;
}

.target-rows {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.target-row {
  display: grid;
  grid-template-columns: 1rem 1fr 120px 3rem 2.5rem;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}

.dot {
  font-size: 0.7rem;
  line-height: 1;
}
.dot-focus  { color: #22c55e; }
.dot-other  { color: #3b82f6; }
.dot-others { color: #8a9cc0; }

.target-name {
  color: #cfd9ee;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.others-row .target-name {
  color: #8a9cc0;
}

.bar-wrap {
  height: 8px;
  background: #1e2840;
  border-radius: 4px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}
.bar-focus  { background: #22c55e; }
.bar-other  { background: #3b82f6; }
.bar-others { background: #475569; }

.pct-label {
  color: #cfd9ee;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pilot-count {
  color: #8a9cc0;
  font-size: 0.78rem;
  text-align: right;
}

.panel-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  color: #8a9cc0;
  border-top: 1px solid #2a3050;
  padding-top: 0.5rem;
  margin-top: 0.1rem;
}

.sep {
  color: #3a4560;
}

@keyframes pulse-alert {
  0%, 100% { border-color: #2a3050; }
  50% { border-color: #ef4444; }
}
.alert-pulse {
  animation: pulse-alert 2s ease-in-out infinite;
}
</style>
