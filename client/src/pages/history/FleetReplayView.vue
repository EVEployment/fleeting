<template>
  <div class="fleet-replay">
    <div class="replay-header">
      <Button icon="pi pi-arrow-left" text @click="$emit('back')" :label="t('replay.backToList')" />
      <h2 v-if="summary">{{ t('replay.fleetTitle', { id: summary.id?.slice(0, 12) ?? '', date: fmtDate(summary.created_at) }) }}</h2>
      <span v-if="summary?.closed_at" class="duration">{{ t('replay.durationMin', { count: summary.duration_min }) }}</span>
    </div>

    <TabView class="replay-tabs">
      <!-- Overview tab -->
      <TabPanel :header="t('replay.tabOverview')">
        <div v-if="summary" class="overview-grid">
          <div class="kv-row"><span>{{ t('replay.kvFc') }}</span><b>{{ summary.fc_name ?? '—' }}</b></div>
          <div class="kv-row"><span>{{ t('replay.kvMembers') }}</span><b>{{ summary.member_count }}</b></div>
          <div class="kv-row"><span>{{ t('replay.kvTotalDamage') }}</span><b>{{ fmtNum(summary.total_damage ?? 0) }}</b></div>
        </div>
        <PresenceTimeline :presence="presence" class="presence-chart" />
      </TabPanel>

      <!-- Combat Timeline tab -->
      <TabPanel :header="t('replay.tabTimeline')">
        <CombatTimeline :points="timelinePoints" @scrub="onScrub" />
        <div v-if="scrubTime" class="scrub-info">
          {{ t('replay.showingSnapshot', { time: fmtTime(scrubTime) }) }}
        </div>
        <MemberTable :members="snapshotAtScrub" />
      </TabPanel>

      <!-- Percentiles tab -->
      <TabPanel :header="t('replay.tabPercentiles')">
        <div class="pilot-selector">
          <Select
            v-model="selectedCharId"
            :options="pilotOptions"
            option-label="label"
            option-value="value"
            :placeholder="t('replay.selectPilot')"
          />
        </div>
        <PercentileChart :points="pilotPercentilePoints" />
      </TabPanel>

      <!-- Participation tab -->
      <TabPanel :header="t('replay.tabParticipation')">
        <DataTable :value="participation" size="small" class="part-table">
          <Column field="characterName" :header="t('col.pilot')"  sortable />
          <Column field="shipName"      :header="t('col.ship')"   sortable>
            <template #body="{ data }">{{ shipName(data.shipName) }}</template>
          </Column>
          <Column field="totalDamage"   :header="t('col.damage')" sortable>
            <template #body="{ data }">{{ fmtNum(data.totalDamage ?? 0) }}</template>
          </Column>
          <Column field="nonCombatPct"  :header="t('col.nonCombatPct')" sortable>
            <template #body="{ data }">{{ (data.nonCombatPct ?? 0).toFixed(1) }}%</template>
          </Column>
          <Column field="status" :header="t('col.status')">
            <template #body="{ data }">
              <ParticipationBadge :status="data.status" :reason="data.reason" />
            </template>
          </Column>
        </DataTable>
      </TabPanel>

      <!-- Events tab -->
      <TabPanel :header="t('replay.tabEvents')">
        <div class="event-filters">
          <InputText v-model="eventFilters.target"  :placeholder="t('replay.filterTarget')"  size="small" />
          <InputText v-model="eventFilters.weapon"  :placeholder="t('replay.filterWeapon')"  size="small" />
          <InputText v-model="eventFilters.charId"  :placeholder="t('replay.filterCharId')"  size="small" />
          <Button :label="t('replay.apply')" size="small" @click="loadEvents(1)" />
        </div>
        <EventLogTable :rows="eventData" @page="loadEvents" />
      </TabPanel>
    </TabView>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useTranslation } from 'i18next-vue';
import TabView from 'primevue/tabview';
import TabPanel from 'primevue/tabpanel';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Select from 'primevue/select';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { api } from '@/api/client';
import CombatTimeline from '@/components/CombatTimeline.vue';
import PercentileChart, { type PercentilePoint } from '@/components/PercentileChart.vue';
import PresenceTimeline from '@/components/PresenceTimeline.vue';
import MemberTable from '@/components/MemberTable.vue';
import BreakdownTable from '@/components/BreakdownTable.vue';
import HitQualityBar from '@/components/HitQualityBar.vue';
import ParticipationBadge from '@/components/ParticipationBadge.vue';
import EventLogTable from '@/components/EventLogTable.vue';
import { useEveNames } from '@/composables/useEveNames';

const props = defineProps<{ fleetId: string }>();
defineEmits<{ back: [] }>();
const { t } = useTranslation();
const { shipName } = useEveNames();


const summary      = ref<any>(null);
const timelineFull = ref<any[]>([]);
const presence     = ref<any[][]>([]);
const participation = ref<any[]>([]);
const eventData    = ref<{ total: number; rows: any[] }>({ total: 0, rows: [] });
const selectedCharId = ref<number | null>(null);
const pilotSnapshots = ref<Record<number, any[]>>({});
const scrubTime    = ref<number | null>(null);

const eventFilters = ref({ target: '', weapon: '', charId: '' });

const timelinePoints = computed(() =>
  timelineFull.value.map(r => ({ ts: new Date(r.bucket_time).getTime() / 1000, totalDps: r.avg_total_dps ?? 0 })),
);

const pilotOptions = computed(() =>
  (summary.value?.members ?? []).map((m: any) => ({ label: m.characterName ?? String(m.characterId), value: m.characterId })),
);

const pilotPercentilePoints = computed((): PercentilePoint[] => {
  if (!selectedCharId.value) return [];
  return (pilotSnapshots.value[selectedCharId.value] ?? []).map(r => ({
    ts:  new Date(r.bucket_ts).getTime() / 1000,
    p50: r.p50, p90: r.p90, p95: r.p95, p99: r.p99, avg: r.avg_dps,
  }));
});

const snapshotAtScrub = ref<any[]>([]);

// Debounced fetch: load fleet snapshot at scrub time from pilot_snapshots
let scrubFetchTimer: ReturnType<typeof setTimeout> | null = null;
watch(scrubTime, (ts) => {
  if (scrubFetchTimer) clearTimeout(scrubFetchTimer);
  if (!ts) { snapshotAtScrub.value = []; return; }
  scrubFetchTimer = setTimeout(async () => {
    const isoTime = new Date(ts * 1000).toISOString();
    const rows: any[] = await api.get(`/api/history/fleet/${props.fleetId}/snapshot-at?t=${encodeURIComponent(isoTime)}`);
    snapshotAtScrub.value = rows.map(r => ({
      characterId:   r.character_id,
      dpsOut:        r.dps_out ?? 0,
      totalDps:      r.dps_out ?? 0,
      dpsIn:         r.dps_in ?? 0,
      logiOut:       r.logi_out ?? 0,
      logiIn:        r.logi_in ?? 0,
      shipTypeId:    r.ship_type_id,
      solarSystemId: r.solar_system_id,
      hitQualityDistribution: r.hit_quality_dist,
    }));
  }, 200);
});

function onScrub(ts: number) { scrubTime.value = ts; }

async function loadEvents(page = 1) {
  const q = new URLSearchParams({ page: String(page), limit: '100' });
  if (eventFilters.value.target)  q.set('target',  eventFilters.value.target);
  if (eventFilters.value.weapon)  q.set('weapon',  eventFilters.value.weapon);
  if (eventFilters.value.charId)  q.set('charId',  eventFilters.value.charId);
  eventData.value = await api.get(`/api/history/fleet/${props.fleetId}/events?${q}`);
}

watch(selectedCharId, async (charId) => {
  if (!charId || pilotSnapshots.value[charId]) return;
  const rows = await api.get(`/api/history/fleet/${props.fleetId}/snapshots/${charId}`);
  pilotSnapshots.value[charId] = rows;
});

function fmtDate(iso: string) { return new Date(iso).toLocaleString(); }
function fmtTime(ts: number)  { return new Date(ts * 1000).toLocaleTimeString(); }
function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

onMounted(async () => {
  const [sum, tl, pres, part] = await Promise.all([
    api.get(`/api/history/fleet/${props.fleetId}/summary`),
    api.get(`/api/history/fleet/${props.fleetId}/timeline`),
    api.get(`/api/history/fleet/${props.fleetId}/presence`),
    api.get(`/api/history/fleet/${props.fleetId}/participation`),
  ]);
  summary.value      = sum;
  timelineFull.value = tl;
  presence.value     = pres;
  participation.value = part.members ?? [];
  await loadEvents();
});
</script>

<style scoped>
.fleet-replay { padding: 1rem 1.5rem; color: #e0e8ff; }
.replay-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
.replay-header h2 { margin: 0; font-size: 1.2rem; }
.duration { color: #8a9cc0; font-size: 0.9rem; }
.overview-grid { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
.kv-row { display: flex; gap: 0.5rem; background: #141928; padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid #2a3050; }
.kv-row span { color: #8a9cc0; }
.presence-chart { margin-top: 1rem; }
.pilot-selector { margin-bottom: 0.75rem; }
.scrub-info { margin: 0.5rem 0; font-size: 0.85rem; color: #8a9cc0; }
.event-filters { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.part-table { background: #141928; border-radius: 8px; overflow: hidden; }
.replay-tabs :deep(.p-tabview-panels) { background: transparent; }
</style>
