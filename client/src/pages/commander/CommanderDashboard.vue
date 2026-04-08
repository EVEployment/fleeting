<template>
  <div class="commander-dashboard">
    <AppNav :me="me">
      <Tag v-if="isWarCommander" :value="t('role.warCommander')" severity="danger" />
      <Tag v-else :value="t('role.fleetCommander')" severity="info" />
      <Button :label="t('logout')" icon="pi pi-sign-out" text @click="logout" />
    </AppNav>

    <main v-if="me">
      <!-- ── Controls bar ── -->
      <div class="fleet-controls">

        <!-- Character multi-select: each character's fleet is auto-discovered.
             Selecting multiple characters aggregates all their fleets. -->
        <div class="fc-section">
          <span class="fc-section-label">{{ t('commander.charactersLabel') }}</span>
          <div class="fc-char-row">
            <MultiSelect
              v-model="selectedFcCharIds"
              :options="characterOptions"
              option-label="label"
              option-value="value"
              :placeholder="t('commander.selectCharacters')"
              size="small"
              class="fc-char-select"
              display="chip"
              :max-selected-labels="0"
            >
              <!-- Chip: character name only, truncated to fit -->
              <template #chip="{ value }">
                <span class="char-chip" :title="charNameById(value)">{{ charNameById(value) }}</span>
              </template>
              <!-- Option row: character name + fleet status on separate lines -->
              <template #option="{ option }">
                <div class="char-option">
                  <span class="char-option-name">{{ charNameOf(option) }}</span>
                  <span class="char-option-fleet" :class="{ muted: !fleetStatusOf(option) }">{{ fleetStatusOf(option) || t('commander.noFleet') }}</span>
                </div>
              </template>
            </MultiSelect>
            <Button
              icon="pi pi-refresh"
              size="small"
              text
              :title="t('commander.recheckFleets')"
              :loading="anyDiscovering"
              :disabled="selectedFcCharIds.length === 0"
              @click="rediscoverSelected"
            />
          </div>
        </div>

        <!-- DPS window (shared) -->
        <label class="window-label">
          {{ t('pilot.dpsWindow') }}
          <InputNumber
            v-model="windowSec"
            :min="10"
            :max="300"
            :step="5"
            show-buttons
            :input-style="{ width: '4rem' }"
          />
        </label>
      </div>

      <!-- Live aggregate stats -->
      <StatsStrip :snapshot="aggregate" />

      <!-- Active DPS indicator (commander-only, not in generic StatsStrip) -->
      <div class="active-dps-tile" :class="{ 'alert-pulse': lowActiveAlert.active.value }">
        <span class="tile-label">{{ t('activeDps.label') }}</span>
        <span class="tile-value">{{ activeCombatCount }} / {{ totalCombatCount }}</span>
      </div>

      <!-- Realtime DPS chart -->
      <DpsChart :snapshot="aggregate" :window-sec="windowSec" class="fleet-chart" :class="{ 'alert-pulse': dpsDropAlert.active.value }" />

      <!-- Per-member table -->
      <MemberTable
        :members="memberRows"
        :fleet-id="primaryFleetId"
        class="member-table"
      />

      <!-- Breakdown + hit quality -->
      <div class="bottom-row">
        <div class="bottom-left">
          <FocusPanel
            :breakdown="aggregate?.breakdown ?? []"
            :total-dps-out="aggregate?.dpsOut ?? 0"
            :alert-active="poorFocusAlert.active.value"
          />
          <BreakdownTable :rows="aggregate?.breakdown ?? []" />
        </div>
        <HitQualityBar
          :distribution-out="aggregate?.hitQualityDistribution ?? {}"
          :distribution-in="aggregate?.hitQualityDistributionIn ?? {}"
        />
      </div>
    </main>

    <div v-else class="loading-state">{{ t('authenticating') }}</div>
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted } from 'vue';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Toast from 'primevue/toast';
import InputNumber from 'primevue/inputnumber';
import MultiSelect from 'primevue/multiselect';
import { useTranslation } from 'i18next-vue';
import { getMe, api, type MeResponse } from '@/api/client';
import { clearMeCache } from '@/router';
import { useFleetSSE } from '@/composables/useFleetSSE';
import { useAlertRule } from '@/composables/useAlertRule';
import { classifyShipRole, isDpsExpected } from '@/lib/shipRoles';
import { MIN_ACTIVE_DPS } from '@/lib/peerEfficiency';
import { computeFocus } from '@/lib/focusAnalysis';
import { shipTypes } from '@/lib/shipTypes';
import AppNav from '@/components/AppNav.vue';
import DpsChart from '@/components/DpsChart.vue';
import MemberTable from '@/components/MemberTable.vue';
import StatsStrip from '@/components/StatsStrip.vue';
import BreakdownTable from '@/components/BreakdownTable.vue';
import HitQualityBar from '@/components/HitQualityBar.vue';
import FocusPanel from '@/components/FocusPanel.vue';

const { t } = useTranslation();

const me             = ref<MeResponse | null>(null);
const isWarCommander = ref(false);
const windowSec      = ref(60);

// ── Per-character fleet discovery ─────────────────────────────────────────────
/** fleetId per characterId discovered via ESI (null = no fleet found) */
const charFleets  = reactive<Record<number, string | null>>({});
/** loading spinner per characterId */
const discovering = reactive<Record<number, boolean>>({});
/** Characters currently selected for monitoring (multi-select) */
const selectedFcCharIds = ref<number[]>([]);

const anyDiscovering = computed(() =>
  selectedFcCharIds.value.some(id => discovering[id]),
);

function charNameById(id: number): string {
  return me.value?.characters.find(c => c.id === id)?.name ?? String(id);
}

const characterOptions = computed(() =>
  (me.value?.characters ?? []).map(c => {
    const fleetId = charFleets[c.id];
    const fleetStatus = fleetId
      ? t('commander.fleetStatus', { id: fleetId.slice(0, 8) })
      : discovering[c.id] ? t('commander.discovering') : '';
    return { label: c.name, fleetStatus, value: c.id };
  }),
);

/** Extract character name from option object (used in custom option slot). */
function charNameOf(option: { label: string }): string {
  return option.label;
}
/** Extract fleet status string from option object. */
function fleetStatusOf(option: { fleetStatus: string }): string {
  return option.fleetStatus;
}

async function discoverForChar(charId: number) {
  discovering[charId] = true;
  try {
    const data = await api.get<{ fleet?: { id: string } | null }>(`/api/fleet/discover?characterId=${charId}`);
    charFleets[charId] = data.fleet?.id ?? null;
  } catch {
    charFleets[charId] = null;
  } finally {
    discovering[charId] = false;
  }
}

async function discoverAllChars() {
  await Promise.all((me.value?.characters ?? []).map(c => discoverForChar(c.id)));
}

function rediscoverSelected() {
  Promise.all(selectedFcCharIds.value.map(discoverForChar));
}

// ── Channel list: union of all selected characters' fleet IDs ─────────────────
const channelIds = computed<string[]>(() => {
  const ids = new Set<string>();
  for (const charId of selectedFcCharIds.value) {
    const fid = charFleets[charId];
    if (fid) ids.add(fid);
  }
  return [...ids];
});

const primaryFleetId = computed(() => channelIds.value[0] ?? null);

// SSE
const { aggregate: fleetData, connected } = useFleetSSE(channelIds);
const aggregate  = fleetData;
const memberRows = computed(() => {
  const snaps = (fleetData.value as any)?.memberSnapshots ?? {};
  return Object.entries(snaps).map(([id, snap]: [string, any]) => ({
    characterId: Number(id),
    ...snap,
  }));
});

// ── Ship role helpers ─────────────────────────────────────────────────────────
function resolveGroupId(shipTypeId: number): number | undefined {
  return shipTypes.get(shipTypeId)?.groupId;
}

const totalCombatCount = computed(() =>
  memberRows.value.filter(m => {
    const groupId = resolveGroupId(m.shipTypeId);
    return groupId != null && isDpsExpected(classifyShipRole(groupId));
  }).length,
);

const activeCombatCount = computed(() =>
  memberRows.value.filter(m => {
    const groupId = resolveGroupId(m.shipTypeId);
    return groupId != null && isDpsExpected(classifyShipRole(groupId)) && (m.dpsOut ?? 0) >= MIN_ACTIVE_DPS;
  }).length,
);

// ── Alert config persistence ──────────────────────────────────────────────────
const ALERT_CONFIG_KEY = 'peld:alertConfig';

function loadAlertConfig(): Record<string, { enabled: boolean; threshold: number }> {
  try {
    const raw = localStorage.getItem(ALERT_CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAlertConfig(config: Record<string, { enabled: boolean; threshold: number }>): void {
  try {
    localStorage.setItem(ALERT_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable
  }
}

const alertConfig = loadAlertConfig();

// ── Alert rules ───────────────────────────────────────────────────────────────
const engagementActive = computed(() => activeCombatCount.value > 0);

const lowActiveEnabled  = ref(alertConfig['lowActive']?.enabled  ?? true);
const dpsDropEnabled    = ref(alertConfig['dpsDrop']?.enabled    ?? true);
const poorFocusEnabled  = ref(alertConfig['poorFocus']?.enabled  ?? true);

// Persist enabled state changes
watch(lowActiveEnabled,  v => { alertConfig['lowActive']  = { ...(alertConfig['lowActive']  ?? {}), enabled: v, threshold: 0.7 }; saveAlertConfig(alertConfig); });
watch(dpsDropEnabled,    v => { alertConfig['dpsDrop']    = { ...(alertConfig['dpsDrop']    ?? {}), enabled: v, threshold: 0.6 }; saveAlertConfig(alertConfig); });
watch(poorFocusEnabled,  v => { alertConfig['poorFocus']  = { ...(alertConfig['poorFocus']  ?? {}), enabled: v, threshold: 0.5 }; saveAlertConfig(alertConfig); });

const lowActiveAlert = useAlertRule({
  id: 'lowActive', label: t('alert.lowActive'),
  getValue: () => totalCombatCount.value > 0 ? activeCombatCount.value / totalCombatCount.value : 1,
  operator: 'lt', threshold: 0.7,
  durationMs: 10000, cooldownMs: 30000,
  gateEngagement: true,
  enabled: lowActiveEnabled,
}, aggregate, connected, engagementActive);

// DPS drop: maintain sliding history (~15s at 2s SSE interval)
const dpsHistory = ref<number[]>([]);
watch(aggregate, (agg) => {
  if (!agg) return;
  dpsHistory.value.push(agg.dpsOut);
  if (dpsHistory.value.length > 8) dpsHistory.value.shift();
});
const dpsMedian = computed(() => {
  if (dpsHistory.value.length < 3) return 0;
  const sorted = [...dpsHistory.value].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
});

const dpsDropAlert = useAlertRule({
  id: 'dpsDrop', label: t('alert.dpsDrop'),
  getValue: () => dpsMedian.value > 0 ? (aggregate.value?.dpsOut ?? 0) / dpsMedian.value : 1,
  operator: 'lt', threshold: 0.6,
  durationMs: 6000, cooldownMs: 20000,
  gateEngagement: true,
  enabled: dpsDropEnabled,
}, aggregate, connected, engagementActive);

const focusResult = computed(() =>
  computeFocus(aggregate.value?.breakdown ?? [], aggregate.value?.dpsOut ?? 0),
);

const poorFocusAlert = useAlertRule({
  id: 'poorFocus', label: t('alert.poorFocus'),
  getValue: () => focusResult.value.coverage > 0.6 ? focusResult.value.focusShare : 1,
  operator: 'lt', threshold: 0.5,
  durationMs: 6000, cooldownMs: 20000,
  gateEngagement: true,
  enabled: poorFocusEnabled,
}, aggregate, connected, engagementActive);

function logout() {
  api.post('/auth/logout', {}).then(() => { clearMeCache(); window.location.href = '/auth/login'; });
}

onMounted(async () => {
  try {
    me.value = await getMe();
    isWarCommander.value = me.value.roles.includes('war_commander');
    // Default to no selected character; user opts in to monitored characters.
    selectedFcCharIds.value = [];
    await discoverAllChars();
  } catch {
    clearMeCache();
    window.location.href = '/auth/login';
  }
});
</script>

<style scoped>
.commander-dashboard { display: flex; flex-direction: column; min-height: 100vh; background: #0d0f14; color: #cfd9ee; }
main { padding: 1rem 1.5rem; display: flex; flex-direction: column; gap: 1rem; }

/* ── Controls bar ── */
.fleet-controls {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
}

.fleet-chart { width: 100%; }
.bottom-row { display: grid; grid-template-columns: 1fr 300px; gap: 1rem; }

.bottom-left {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.active-dps-tile {
  background: #141928;
  border: 1px solid #2a3050;
  border-radius: 8px;
  padding: 0.6rem 1rem;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  align-self: flex-start;
}
.active-dps-tile .tile-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #8a9cc0;
}
.active-dps-tile .tile-value {
  font-size: 1.4rem;
  font-weight: 700;
  color: #7eb8ff;
}

@keyframes pulse-alert {
  0%, 100% { border-color: #2a3050; }
  50% { border-color: #ef4444; }
}
.alert-pulse {
  animation: pulse-alert 2s ease-in-out infinite;
}
.loading-state { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; opacity: 0.5; }

/* FC character section */
.fc-section { display: flex; flex-direction: column; gap: 0.4rem; }
.fc-section-label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8a9cc0; }
.fc-char-row { display: flex; align-items: center; gap: 0.5rem; }
.fc-char-select { width: 320px; flex-shrink: 0; }

.char-chip {
  display: inline-block;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  vertical-align: middle;
}

/* Style the PrimeVue Chip wrapper that surrounds each char-chip.
   :deep() is required because scoped CSS cannot reach PrimeVue's rendered DOM. */
.fc-char-select :deep(.p-chip) {
  background: #1e2d45;
  border: 1px solid #2e4a6e;
  border-radius: 4px;
  padding: 0.15rem 0.45rem;
  gap: 0;
}
.fc-char-select :deep(.p-chip .p-chip-label) {
  font-size: 0.8rem;
  color: #9bbde0;
  line-height: 1.4;
}

/* Custom option layout: name above, fleet status below */
.char-option {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.char-option-name {
  font-weight: 600;
  font-size: 0.88rem;
  color: #cfd9ee;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.char-option-fleet {
  font-size: 0.76rem;
  color: #4fc3d1;
}
.char-option-fleet.muted { color: #5b6f8e; font-style: italic; }

.window-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: #8a9cc0;
  margin-left: auto;
  align-self: center;
}
</style>
