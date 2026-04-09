<template>
  <div ref="el" class="percentile-chart" />
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface PercentilePoint {
  ts: number;      // unix seconds (bucket time)
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
}

export interface PeerMedianPoint {
  ts: number;
  median: number;
}

const props = defineProps<{ points: PercentilePoint[] }>();

const el = ref<HTMLDivElement | null>(null);
let chart: uPlot | null = null;

function buildData(): uPlot.AlignedData {
  return [
    props.points.map(p => p.ts),
    props.points.map(p => p.p50),
    props.points.map(p => p.p90),
    props.points.map(p => p.p95),
    props.points.map(p => p.p99),
    props.points.map(p => p.avg),
  ];
}

function initChart() {
  if (!el.value) return;
  chart?.destroy();
  const opts: uPlot.Options = {
    width:  el.value.clientWidth || 700,
    height: 200,
    series: [
      {},
      { label: 'p50',  stroke: '#4caf50', width: 1 },
      { label: 'p90',  stroke: '#ff9800', width: 1 },
      { label: 'p95',  stroke: '#f44336', width: 1.5 },
      { label: 'p99',  stroke: '#e91e63', width: 2 },
      { label: 'avg',  stroke: '#7eb8ff', width: 1, dash: [4, 4] },
    ],
    axes: [
      { stroke: '#8a9cc0' },
      { stroke: '#8a9cc0', grid: { stroke: '#1e2a45' }, label: 'Damage' },
    ],
    scales: { x: { time: true } },
  };
  chart = new uPlot(opts, buildData(), el.value);
}

watch(() => props.points, () => { chart?.setData(buildData()); }, { deep: true });

const ro = new ResizeObserver(() => {
  if (el.value && chart) chart.setSize({ width: el.value.clientWidth, height: 200 });
});

onMounted(() => { initChart(); if (el.value) ro.observe(el.value); });
onUnmounted(() => { ro.disconnect(); chart?.destroy(); });
</script>

<style scoped>
.percentile-chart { background: #141928; border: 1px solid #2a3050; border-radius: 8px; overflow: hidden; padding: 0.5rem; }
</style>
