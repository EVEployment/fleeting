<template>
  <DataTable
    v-model:expandedRows="expandedRows"
    :value="enrichedMembers"
    data-key="_idx"
    size="small"
    class="member-table"
    scrollable
    scroll-height="400px"
    :sort-field="'characterName'"
    :sort-order="1"
    :row-class="rowClass"
  >
    <Column expander style="width: 2.5rem" />
    <Column field="characterName" :header="t('col.pilot')" sortable style="min-width:140px" />
    <Column field="shipName"      :header="t('col.ship')"  sortable style="min-width:120px">
      <template #body="{ data }">
        <span>{{ shipName(data.shipName) }}</span>
      </template>
    </Column>
    <Column :header="t('col.class')" sortable style="min-width:110px" :sort-field="(r: any) => shipCategory(r.shipName)">
      <template #body="{ data }">
        <span class="ship-cat">{{ shipCategory(data.shipName) }}</span>
      </template>
    </Column>
    <Column field="location"      :header="t('col.system')" sortable style="min-width:100px" />
    <Column field="totalDps"      :header="t('col.dps')"   sortable style="min-width:80px">
      <template #body="{ data }">{{ fmt(data.totalDps ?? 0) }}</template>
    </Column>
    <Column :header="t('col.role')" sortable style="min-width:90px"
      :sort-field="(r: any) => classifyShipRole(resolveGroupId(r.shipTypeId) ?? 0)">
      <template #body="{ data }">
        <Tag :value="roleLabel(classifyShipRole(resolveGroupId(data.shipTypeId) ?? 0))"
             :pt="{ root: { style: { background: roleColor(classifyShipRole(resolveGroupId(data.shipTypeId) ?? 0)), color: '#fff', fontSize: '0.78rem' } } }" />
      </template>
    </Column>
    <Column :header="t('col.efficiency')" sortable style="min-width:85px"
      :sort-field="(r: any) => getEfficiency(r)">
      <template #body="{ data }">
        <span :style="effStyle(data)">{{ effLabel(data) }}</span>
      </template>
    </Column>
    <Column field="participation" :header="t('col.status')" style="min-width:100px">
      <template #body="{ data }">
        <ParticipationBadge
          :status="data.participation ?? 'participant'"
          :reason="data.participationReason"
        />
      </template>
    </Column>
    <template #expansion="{ data }">
      <div class="hq-expansion">
        <div class="hq-expansion-label">{{ t('hqDiag.title') }}</div>
        <template v-if="hasHitQuality(data)">
          <div class="hq-bar-row">
            <div
              v-for="q in activeQualities(data)"
              :key="q.name"
              class="hq-bar-segment"
              :style="{ flex: q.count, backgroundColor: q.color }"
              :title="`${q.name}: ${q.count} (${q.pct}%)`"
            >
              <span v-if="q.pct >= 8" class="hq-bar-text">{{ q.name }} {{ q.pct }}%</span>
            </div>
          </div>
          <div class="hq-diag-hint" v-if="hqDiagnostic(data)">{{ hqDiagnostic(data) }}</div>
        </template>
        <div v-else class="hq-no-data">{{ t('hqDiag.noTurretData') }}</div>
      </div>
    </template>
  </DataTable>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Tag from 'primevue/tag';
import ParticipationBadge from './ParticipationBadge.vue';
import { useEveNames } from '@/composables/useEveNames';
import { useTranslation } from 'i18next-vue';
import { classifyShipRole, type ShipRole } from '@/lib/shipRoles';
import { computePeerEfficiency, type PilotEfficiency } from '@/lib/peerEfficiency';
import { shipTypes } from '@/lib/shipTypes';
import { HIT_QUALITIES, HIT_QUALITY_COLOR } from '@/lib/hitQuality';

const { shipName, shipCategory } = useEveNames();
const { t } = useTranslation();

const props = defineProps<{ members: any[]; fleetId?: string | null }>();

function resolveGroupId(shipTypeId: number | undefined): number | undefined {
  if (shipTypeId === undefined) return undefined;
  return shipTypes.get(shipTypeId)?.groupId;
}

// Enrich each member with a synthetic _idx so efficiency results can be matched
// by position (computePeerEfficiency returns in the same order as input).
const enrichedMembers = computed(() =>
  props.members.map((m, i) => ({ ...m, _idx: i })),
);

const pilotEfficiencies = computed<PilotEfficiency[]>(() => {
  if (!enrichedMembers.value.length) return [];
  // Provide a synthetic characterId (index) when not present in data
  const membersWithId = enrichedMembers.value.map((m, i) => ({
    ...m,
    characterId: m.characterId ?? i,
  }));
  return computePeerEfficiency(membersWithId, resolveGroupId);
});

// Keyed by _idx for O(1) lookup without depending on characterId from data
const efficiencyByIdx = computed<Map<number, PilotEfficiency>>(() => {
  const map = new Map<number, PilotEfficiency>();
  enrichedMembers.value.forEach((m, i) => {
    const eff = pilotEfficiencies.value[i];
    if (eff) map.set(m._idx, eff);
  });
  return map;
});

function fmt(v: number) {
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function roleColor(role: ShipRole): string {
  switch (role) {
    case 'combat':     return '#c0392b';
    case 'logistics':  return '#27ae60';
    case 'command':    return '#2980b9';
    case 'tackle':     return '#8e44ad';
    case 'ewar':       return '#d4ac0d';
    case 'support':    return '#5b6f8e';
    case 'non-combat': return '#3b3b3b';
    default:           return '#5b6f8e';
  }
}

function roleLabel(role: ShipRole): string {
  switch (role) {
    case 'combat':     return 'DPS';
    case 'logistics':  return 'LOGI';
    case 'command':    return 'CMD';
    case 'tackle':     return 'TCKL';
    case 'ewar':       return 'EWAR';
    case 'support':    return 'SUP';
    case 'non-combat': return '—';
    default:           return '—';
  }
}

function getEfficiency(row: any): number {
  const eff = efficiencyByIdx.value.get(row._idx);
  return eff?.efficiency ?? -1;
}

function effLabel(row: any): string {
  const eff = efficiencyByIdx.value.get(row._idx);
  if (!eff) return '—';
  if (eff.role === 'logistics' || eff.role === 'support') return 'N/A';
  if (eff.isZeroDps) return 'ZERO';
  if (eff.efficiency === null) return '—';
  const pct = Math.round(eff.efficiency * 100) + '%';
  return eff.confidenceLevel === 'low' ? pct + '~' : pct;
}

function effStyle(row: any): Record<string, string> {
  const eff = efficiencyByIdx.value.get(row._idx);
  if (!eff) return { color: '#5b6f8e' };
  if (eff.role === 'logistics' || eff.role === 'support') return { color: '#5b6f8e' };
  if (eff.isZeroDps) return { color: '#ef4444', fontWeight: 'bold', animation: 'blink-zero 1.5s ease-in-out infinite' };
  if (eff.efficiency === null) return { color: '#5b6f8e' };
  if (eff.efficiency > 1.2)  return { color: '#c8a84b' };
  if (eff.efficiency >= 0.8) return { color: '#22c55e' };
  if (eff.efficiency >= 0.4) return { color: '#eab308' };
  return { color: '#ef4444' };
}

// ── Row class for zero-DPS highlight ─────────────────────────────────────────
function rowClass(data: any): string | undefined {
  const eff = efficiencyByIdx.value.get(data._idx);
  if (eff?.isZeroDps) return 'zero-dps-row';
  return undefined;
}

// ── Hit Quality expandable row ───────────────────────────────────────────────
const expandedRows = ref<Record<string, boolean>>({});

function hasHitQuality(row: any): boolean {
  const dist = row.hitQualityDistribution as Record<string, number> | undefined;
  if (!dist) return false;
  return Object.values(dist).some(v => v > 0);
}

function activeQualities(row: any): { name: string; count: number; pct: number; color: string }[] {
  const dist = (row.hitQualityDistribution ?? {}) as Record<string, number>;
  const total = Object.values(dist).reduce((s, v) => s + v, 0);
  if (total === 0) return [];
  return HIT_QUALITIES
    .filter(q => (dist[q] ?? 0) > 0)
    .map(q => ({
      name: q,
      count: dist[q] ?? 0,
      pct: Math.round(((dist[q] ?? 0) / total) * 100),
      color: HIT_QUALITY_COLOR[q] ?? '#4b5563',
    }));
}

function hqDiagnostic(row: any): string | null {
  const quals = activeQualities(row);
  if (quals.length === 0) return null;
  const total = quals.reduce((s, q) => s + q.count, 0);
  const poorHits = quals
    .filter(q => q.name === 'Grazes' || q.name === 'Glances Off' || q.name === 'Misses')
    .reduce((s, q) => s + q.count, 0);
  if (poorHits / total > 0.4) return t('hqDiag.trackingIssue');
  // All "Hits" with no variance → likely missile-only or smartbomb
  if (quals.length === 1 && quals[0].name === 'Hits') return t('hqDiag.missileOnly');
  return null;
}
</script>

<style scoped>
.member-table { background: #141928; border-radius: 8px; overflow: hidden; }
.ship-cat { font-size: 0.8rem; color: #8a9cc0; }

/* ── Hit Quality expansion row ── */
.hq-expansion {
  padding: 0.5rem 1rem;
  background: #0f1320;
}
.hq-expansion-label {
  font-size: 0.75rem;
  color: #8a9cc0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 0.4rem;
}
.hq-bar-row {
  display: flex;
  height: 22px;
  border-radius: 4px;
  overflow: hidden;
  gap: 1px;
}
.hq-bar-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  transition: flex 0.3s ease;
}
.hq-bar-text {
  font-size: 0.68rem;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 4px;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
}
.hq-diag-hint {
  margin-top: 0.35rem;
  font-size: 0.78rem;
  color: #eab308;
  font-style: italic;
}
.hq-no-data {
  font-size: 0.82rem;
  color: #5b6f8e;
  padding: 0.25rem 0;
}

/* ── Zero DPS row highlight ── */
:deep(.zero-dps-row) {
  background: rgba(239, 68, 68, 0.08) !important;
}

@keyframes blink-zero {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
