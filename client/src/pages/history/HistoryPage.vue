<template>
  <div class="history-page">
    <AppNav :me="me">
      <Button :label="t('logout')" icon="pi pi-sign-out" text @click="logout" />
    </AppNav>

    <main v-if="!selectedFleetId">
      <div class="page-header">
        <h2>{{ t('history.pageTitle') }}</h2>
      </div>
      <DataTable
        :value="fleets"
        :total-records="totalFleets"
        :rows="pageSize"
        lazy
        paginator
        size="small"
        class="fleet-list"
        @page="loadFleets($event.page + 1)"
        @row-click="openFleet($event.data.id)"
        row-hover
      >
        <Column field="id"            :header="t('col.fleetId')"  style="min-width:160px">
          <template #body="{ data }">{{ data.id.slice(0, 12) }}…</template>
        </Column>
        <Column field="fc_name"       :header="t('col.fc')"       style="min-width:120px" />
        <Column field="member_count"  :header="t('col.members')"  style="min-width:80px" />
        <Column field="created_at"    :header="t('col.started')"  style="min-width:140px">
          <template #body="{ data }">{{ fmtDate(data.created_at) }}</template>
        </Column>
        <Column field="closed_at"     :header="t('col.ended')"    style="min-width:140px">
          <template #body="{ data }">{{ data.closed_at ? fmtDate(data.closed_at) : '—' }}</template>
        </Column>
        <Column field="duration_min"  :header="t('col.duration')" style="min-width:80px">
          <template #body="{ data }">{{ data.duration_min != null ? t('history.durationMin', { count: data.duration_min }) : '—' }}</template>
        </Column>
        <Column field="ship_type_ids" :header="t('col.composition')" style="min-width:180px">
          <template #body="{ data }">
            <template v-if="data.ship_type_ids?.length">
              <span v-for="(r, i) in summarizeComposition(data.ship_type_ids)" :key="r.label"
                    :style="{ color: r.color, fontSize: '0.85rem' }">
                {{ r.count }} {{ r.label }}<span v-if="i < summarizeComposition(data.ship_type_ids).length - 1" style="color:#666"> · </span>
              </span>
            </template>
            <span v-else style="color:#666">—</span>
          </template>
        </Column>
      </DataTable>
    </main>

    <FleetReplayView
      v-else
      :fleet-id="selectedFleetId"
      @back="selectedFleetId = null"
    />

    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useTranslation } from 'i18next-vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import Toast from 'primevue/toast';
import { api, getMe, type MeResponse } from '@/api/client';
import { clearMeCache } from '@/router';
import AppNav from '@/components/AppNav.vue';
import FleetReplayView from './FleetReplayView.vue';
import { shipTypes } from '@/lib/shipTypes';
import { classifyShipRole, type ShipRole } from '@/lib/shipRoles';

const me             = ref<MeResponse | null>(null);
const fleets         = ref<any[]>([]);
const totalFleets    = ref(0);
const pageSize       = 20;
const selectedFleetId = ref<string | null>(null);

const { t } = useTranslation();

async function loadFleets(page = 1) {
  try {
    const data = await api.get(`/api/history/fleets?page=${page}&limit=${pageSize}`);
    fleets.value      = data.fleets;
    totalFleets.value = data.total;
  } catch (e) {
    console.error(e);
  }
}

function openFleet(id: string) { selectedFleetId.value = id; }

const ROLE_DISPLAY: { role: ShipRole; label: string; color: string }[] = [
  { role: 'combat',     label: 'DPS',  color: '#c0392b' },
  { role: 'logistics',  label: 'LOGI', color: '#27ae60' },
  { role: 'command',    label: 'CMD',  color: '#2980b9' },
  { role: 'tackle',     label: 'TCKL', color: '#8e44ad' },
  { role: 'ewar',       label: 'EWAR', color: '#d4ac0d' },
  { role: 'support',    label: 'SUP',  color: '#5b6f8e' },
];

function summarizeComposition(shipTypeIds: number[]): { label: string; count: number; color: string }[] {
  const counts = new Map<ShipRole, number>();
  for (const typeId of shipTypeIds) {
    const groupId = shipTypes.get(typeId)?.groupId;
    const role = groupId !== undefined ? classifyShipRole(groupId) : 'combat';
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return ROLE_DISPLAY
    .filter(r => (counts.get(r.role) ?? 0) > 0)
    .map(r => ({ label: r.label, count: counts.get(r.role)!, color: r.color }));
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function logout() {
  api.post('/auth/logout', {}).then(() => { clearMeCache(); window.location.href = '/auth/login'; });
}

onMounted(async () => {
  try {
    me.value = await getMe();
  } catch {
    clearMeCache();
    window.location.href = '/auth/login';
    return;
  }
  await loadFleets();
});
</script>

<style scoped>
.history-page { display: flex; flex-direction: column; min-height: 100vh; background: #0d0f14; color: #cfd9ee; }
main { padding: 1rem 1.5rem; }
.page-header h2 { margin: 0 0 1rem; color: #c8a84b; }
.fleet-list { background: #13181f; border-radius: 4px; overflow: hidden; cursor: pointer; }
</style>
