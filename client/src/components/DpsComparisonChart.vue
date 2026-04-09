<template>
  <div ref="el" class="dps-comparison-chart" />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface DpsPoint {
  ts: number;
  dps: number;
}

export interface PeerMedianPoint {
  ts: number;
  median: number;
}

const props = defineProps<{
  pilotDps: DpsPoint[];
  peerMedian: PeerMedianPoint[];
}>();

const el = ref<HTMLDivElement | null>(null);
let chart: uPlot | null = null;

function buildData(): uPlot.AlignedData {
  // Merge both time axes and align
  const tsSet = new Set<number>();
  for (const p of props.pilotDps) tsSet.add(p.ts);
  for (const p of props.peerMedian) tsSet.add(p.ts);
  const ts = [...tsSet].sort((a, b) => a - b);

  const pilotMap = new Map<number, number>();
  for (const p of props.pilotDps) pilotMap.set(p.ts, p.dps);
  const peerMap = new Map<number, number>();
  for (const p of props.peerMedian) peerMap.set(p.ts, p.median);

  return [
    ts,
    ts.map(t => pilotMap.get(t) ?? null) as (number | null)[],
    ts.map(t => peerMap.get(t) ?? null) as (number | null)[],
  ];
}

function initChart() {
  if (!el.value) return;
  chart?.destroy();
  const opts: uPlot.Options = {
    width: el.value.clientWidth || 700,
    height: 150,
    series: [
      {},
      { label: 'Pilot DPS', stroke: '#7eb8ff', width: 1.5 },
      { label: 'Peer Median', stroke: '#c8a84b', width: 2, dash: [6, 3] },
    ],
    axes: [
      { stroke: '#8a9cc0' },
      { stroke: '#8a9cc0', grid: { stroke: '#1e2a45' }, label: 'DPS' },
    ],
    scales: { x: { time: true } },
  };
  chart = new uPlot(opts, buildData(), el.value);
}

watch([() => props.pilotDps, () => props.peerMedian], () => { chart?.setData(buildData()); }, { deep: true });

const ro = new ResizeObserver(() => {
  if (el.value && chart) chart.setSize({ width: el.value.clientWidth, height: 150 });
});

onMounted(() => { initChart(); if (el.value) ro.observe(el.value); });
onUnmounted(() => { ro.disconnect(); chart?.destroy(); });
</script>

<style scoped>
.dps-comparison-chart { background: #141928; border: 1px solid #2a3050; border-radius: 8px; overflow: hidden; padding: 0.5rem; margin-top: 0.75rem; }
</style>
