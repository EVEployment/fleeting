<template>
  <div class="pilot-dashboard">
    <AppNav :me="me">
      <Select
        v-if="me"
        :modelValue="selectedCharId"
        :options="characterOptions"
        option-label="label"
        option-value="value"
        :placeholder="t('pilot.selectCharacter')"
        class="char-select"
        @update:modelValue="onCharacterModelUpdate"
      >
        <template #option="{ option }">
          <div class="char-option">
            <span class="char-option-name">{{ option.label }}</span>
            <span
              class="char-option-status"
              :class="{
                'status-online':  option.online === true,
                'status-offline': option.online === false,
                'status-unknown': option.online === null,
              }"
            >
              {{
                option.online === true  ? t('character.online')  :
                option.online === false ? t('character.offline') :
                t('character.checking')
              }}
            </span>
          </div>
        </template>
      </Select>
      <Button
        v-if="!logRunning"
        :label="t('pilot.openLogs')"
        icon="pi pi-folder-open"
        outlined
        @click="openLogs"
      />
      <Button
        v-else
        :label="t('pilot.stopLogs')"
        icon="pi pi-stop"
        severity="danger"
        outlined
        @click="stopAndForget"
      />
      <OverviewManager :me="me" @change="onOverviewChange" />
      <Button :label="t('logout')" icon="pi pi-sign-out" text @click="logout" />
    </AppNav>

    <main v-if="me">
      <!-- Log loading indicator -->
      <div v-if="logLoading" class="log-loading-banner">
        <i class="pi pi-spin pi-spinner" />
        {{ t('pilot.scanningLogs') }}
      </div>

      <!-- Settings bar -->
      <div class="settings-bar">
        <label>{{ t('pilot.dpsWindow') }}
          <InputNumber v-model="windowSec" :min="10" :max="300" :step="5" show-buttons />
        </label>
        <label>{{ t('pilot.chartMetric') }}
          <Select
            v-model="selectedMetric"
            :options="metricOptions"
            option-label="label"
            option-value="value"
            class="chart-setting-select"
          />
        </label>
        <label>{{ t('pilot.chartTickSec') }}
          <InputNumber v-model="chartTickSec" :min="1" :max="10" :step="1" show-buttons />
        </label>
        <label>{{ t('pilot.aggregateHistoryMin') }}
          <InputNumber v-model="aggregateHistoryMin" :min="1" :max="30" :step="1" show-buttons />
        </label>
        <label>{{ t('pilot.characterHistoryMin') }}
          <InputNumber v-model="characterHistoryMin" :min="1" :max="30" :step="1" show-buttons />
        </label>
        <span v-if="fleetInfo" class="fleet-badge">
          {{ t('pilot.fleetUploading', { id: fleetInfo.fleetId }) }}
        </span>
        <span v-if="!fleetInfo && logRunning" class="fleet-badge muted">
          {{ t('pilot.noFleetLocal') }}
        </span>
      </div>

      <div class="charts-grid">
        <!-- All-characters aggregate (left) -->
        <div class="chart-section">
          <div class="section-heading">{{ t('pilot.allCharsAggregate') }}</div>
          <StatsStrip :snapshot="allSnap" />
          <DpsChart
            :snapshot="allSnap"
            :metric="selectedMetric"
            :sample-ms="chartTickMs"
            :history-sec="aggregateHistorySec"
          />
        </div>

        <!-- Per-character live stats (right) -->
        <div class="chart-section">
          <div class="section-heading">{{ selectedCharName ?? t('pilot.characterFallback') }}</div>
          <StatsStrip :snapshot="snap" />
          <!-- One DpsChart per character kept alive with v-show to preserve chart history -->
          <template v-for="char in me!.characters" :key="char.id">
            <DpsChart
              v-show="char.id === selectedCharIdNum"
              :snapshot="charSnapshots[char.id] ?? null"
              :metric="selectedMetric"
              :sample-ms="chartTickMs"
              :history-sec="characterHistorySec"
            />
          </template>
        </div>
      </div>

      <div class="bottom-row">
        <BreakdownTable :rows="allSnap?.breakdown ?? []" class="breakdown" />
        <HitQualityBar
          :distribution-out="allSnap?.hitQualityDistribution ?? {}"
          :distribution-in="allSnap?.hitQualityDistributionIn ?? {}"
          class="hq-bar"
        />
      </div>

      <LiveEventLog ref="liveLogRef" class="live-log-section" />
    </main>

    <div v-else class="loading-state">{{ t('authenticating') }}</div>
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive, onMounted, onUnmounted, nextTick } from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import InputNumber from 'primevue/inputnumber';
import Toast from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import { useTranslation } from 'i18next-vue';
import { api, getMe, type MeResponse } from '@/api/client';
import { clearMeCache } from '@/router';
import { IDB_KEYS, deleteIdbValue, loadIdbValue, saveIdbValue, type PilotSessionCache } from '@/lib/logCache';
import { useLogReader } from '@/composables/useLogReader';
import { useOverviewSettings } from '@/composables/useOverviewSettings';
import { useDpsEngine, type BreakdownEntry, type DpsSnapshot } from '@/composables/useDpsEngine';
import { useCharacterStatus } from '@/composables/useCharacterStatus';
import type { LogEntry } from '@/lib/logRegex';
import { emptyDistribution } from '@/lib/hitQuality';
import AppNav from '@/components/AppNav.vue';
import DpsChart from '@/components/DpsChart.vue';
import StatsStrip from '@/components/StatsStrip.vue';
import BreakdownTable from '@/components/BreakdownTable.vue';
import HitQualityBar from '@/components/HitQualityBar.vue';
import OverviewManager from '@/components/OverviewManager.vue';
import LiveEventLog from '@/components/LiveEventLog.vue';
import type { ChartMetricKey } from '@/components/DpsChart.vue';

const toast  = useToast();
const { t } = useTranslation();
const me     = ref<MeResponse | null>(null);
const selectedCharId = ref<number | string | null>(null);
const windowSec = ref(60);
const selectedMetric = ref<ChartMetricKey>('dpsOut');
const chartTickSec = ref(1);
const aggregateHistoryMin = ref(5);
const characterHistoryMin = ref(5);
const PILOT_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

const { charStatus, start: startCharacterStatus } = useCharacterStatus();

const DEBUG_CHAR = true;

function debugChar(...args: unknown[]) {
  if (!DEBUG_CHAR) return;
  console.info('[char-debug][PilotDashboard]', ...args);
}

function onCharacterModelUpdate(value: number | string | null | undefined) {
  const normalized = value == null ? null : value;
  debugChar('select:update:model-value', {
    raw: value,
    normalized,
    previous: selectedCharId.value,
  });
  selectedCharId.value = normalized;
}

const selectedCharIdNum = computed<number | null>(() => {
  if (selectedCharId.value == null) return null;
  const parsed = Number(selectedCharId.value);
  return Number.isFinite(parsed) ? parsed : null;
});

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

const characterOptions = computed(() =>
  (me.value?.characters ?? []).map(c => ({
    label:  c.name,
    value:  c.id,
    online: charStatus[c.id]?.online ?? null,
  })),
);

const metricOptions = computed(() => [
  { label: t('stat.dpsOut'), value: 'dpsOut' },
  { label: t('stat.dpsIn'), value: 'dpsIn' },
  { label: t('stat.logiOut'), value: 'logiOut' },
  { label: t('stat.logiIn'), value: 'logiIn' },
  { label: t('categoryValue.capTransfered'), value: 'capTransfered' },
  { label: t('categoryValue.capRecieved'), value: 'capRecieved' },
  { label: t('categoryValue.capDamageOut'), value: 'capDamageOut' },
  { label: t('categoryValue.capDamageIn'), value: 'capDamageIn' },
  { label: t('categoryValue.mined'), value: 'mined' },
] as Array<{ label: string; value: ChartMetricKey }>);

const chartTickMs = computed(() => Math.max(1, Number(chartTickSec.value || 1)) * 1000);
const aggregateHistorySec = computed(() => Math.max(1, Number(aggregateHistoryMin.value || 5)) * 60);
const characterHistorySec = computed(() => Math.max(1, Number(characterHistoryMin.value || 5)) * 60);

// Log reader
const { running: logRunning, isLoading: logLoading, pickDirectory: openDirectory, tryRestoreDirectory, forgetDirectory, stop: stopLogs, syncOverviews, onEntries } = useLogReader();

type LiveLogController = {
  push(entries: LogEntry[]): void;
  clear(): void;
  snapshot(): LogEntry[];
  restore(entries: LogEntry[]): void;
};

const liveLogRef = ref<LiveLogController | null>(null);

// Overview settings — per character, persisted in localStorage
const { getAll: getAllOverviews } = useOverviewSettings();

/** Called when the user uploads, duplicates, or resets any character's overview */
function onOverviewChange() {
  syncOverviews(getAllOverviews());
}

// DPS engine — one per character, kept alive forever so switching back restores history.
// NOTE: NOT using reactive() here because useDpsEngine returns Ref/Computed objects that
// need to maintain their own reactivity. reactive() would wrap them improperly.
type Engine = ReturnType<typeof useDpsEngine>;
const charEngines: Record<number, Engine> = {};

function getOrCreateEngine(charId: number): Engine {
  if (!charEngines[charId]) charEngines[charId] = useDpsEngine(windowSec);
  return charEngines[charId];
}

// Map character id → current DpsSnapshot (reactive, auto-updates as logs arrive)
const charSnapshots = computed<Record<number, typeof charEngines[number]['snapshot']['value'] | null>>(() => {
  const result: Record<number, typeof charEngines[number]['snapshot']['value'] | null> = {};
  for (const id of Object.keys(charEngines).map(Number)) {
    result[id] = charEngines[id]?.snapshot.value ?? null;
  }
  return result;
});

// Snapshot for whichever character is currently selected
const snap = computed(() => selectedCharIdNum.value != null ? (charSnapshots.value[selectedCharIdNum.value] ?? null) : null);

const EMPTY_PERCENTILES = { p50: 0, p90: 0, p95: 0, p99: 0, avg: 0, median: 0 };

function aggregateCharacterSnapshots(values: Array<DpsSnapshot | null>): DpsSnapshot {
  const outDist = emptyDistribution();
  const inDist = emptyDistribution();
  const breakdownMap = new Map<string, BreakdownEntry>();
  const sums = {
    dpsOut: 0,
    dpsIn: 0,
    logiOut: 0,
    logiIn: 0,
    capTransfered: 0,
    capRecieved: 0,
    capDamageOut: 0,
    capDamageIn: 0,
    mined: 0,
  };

  for (const s of values) {
    if (!s) continue;
    sums.dpsOut += s.dpsOut;
    sums.dpsIn += s.dpsIn;
    sums.logiOut += s.logiOut;
    sums.logiIn += s.logiIn;
    sums.capTransfered += s.capTransfered;
    sums.capRecieved += s.capRecieved;
    sums.capDamageOut += s.capDamageOut;
    sums.capDamageIn += s.capDamageIn;
    sums.mined += s.mined;

    for (const [k, v] of Object.entries(s.hitQualityDistribution)) outDist[k] = (outDist[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.hitQualityDistributionIn)) inDist[k] = (inDist[k] ?? 0) + v;

    for (const row of s.breakdown) {
      const key = `${row.pilotName}\x00${row.weaponType}\x00${row.shipType}\x00${row.category}\x00${row.targetName}`;
      const existing = breakdownMap.get(key);
      if (!existing) {
        breakdownMap.set(key, {
          ...row,
          hitQualityDistribution: { ...row.hitQualityDistribution },
        });
        continue;
      }
      existing.amount += row.amount;
      existing.hits += row.hits;
      if (row.occurredAt > existing.occurredAt) existing.occurredAt = row.occurredAt;
      for (const [hq, c] of Object.entries(row.hitQualityDistribution)) {
        existing.hitQualityDistribution[hq] = (existing.hitQualityDistribution[hq] ?? 0) + c;
      }
    }
  }

  let dominantHitQuality: string | null = null;
  let best = 0;
  for (const [k, v] of Object.entries(outDist)) {
    if (v > best) {
      best = v;
      dominantHitQuality = k;
    }
  }

  // Sort and cap to top 100 entries by amount to prevent memory bloat
  const breakdown = [...breakdownMap.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 100)
    .map(row => ({
      ...row,
      // Prune hitQualityDistribution to remove zero/insignificant entries
      hitQualityDistribution: Object.fromEntries(
        Object.entries(row.hitQualityDistribution).filter(([_, count]) => count > 0)
      ),
    }));

  return {
    ...sums,
    breakdown,
    hitQualityDistribution: outDist,
    hitQualityDistributionIn: inDist,
    dominantHitQuality: null, // No longer used; per-row quality computed in BreakdownTable
    percentiles: EMPTY_PERCENTILES,
  };
}

const allSnap = computed<DpsSnapshot>(() =>
  aggregateCharacterSnapshots(Object.values(charSnapshots.value)),
);

const selectedCharName = computed(() =>
  me.value?.characters.find(c => c.id === selectedCharIdNum.value)?.name ?? null,
);

watch(selectedCharId, (val, prev) => {
  debugChar('watch:selectedCharId', { prev, val, type: typeof val });
});

watch(selectedCharIdNum, (val, prev) => {
  debugChar('watch:selectedCharIdNum', { prev, val });
});

watch(selectedCharName, (val, prev) => {
  debugChar('watch:selectedCharName', { prev, val });
});

watch(selectedCharId, () => {
  void persistPilotSessionCache();
});

async function clearPilotSessionCache() {
  await deleteIdbValue(IDB_KEYS.pilotSession);
}

async function persistPilotSessionCache() {
  const perCharacterEntries: Record<string, ReturnType<Engine['exportBuffer']>> = {};
  for (const [charId, engine] of Object.entries(charEngines)) {
    perCharacterEntries[charId] = engine.exportBuffer();
  }
  const allEntries = Object.values(perCharacterEntries)
    .flat()
    .sort((a, b) => a.timestamp - b.timestamp);
  const payload: PilotSessionCache = {
    version: 1,
    cachedAt: Date.now(),
    selectedCharId: selectedCharId.value,
    allEntries,
    perCharacterEntries,
    liveEntries: liveLogRef.value?.snapshot() ?? [],
  };
  await saveIdbValue(IDB_KEYS.pilotSession, payload);
}

async function restorePilotSessionCache() {
  const cache = await loadIdbValue<PilotSessionCache>(IDB_KEYS.pilotSession);
  if (!cache || cache.version !== 1) return false;
  if (Date.now() - cache.cachedAt > PILOT_SESSION_MAX_AGE_MS) {
    await clearPilotSessionCache();
    return false;
  }

  for (const [charId, entries] of Object.entries(cache.perCharacterEntries)) {
    getOrCreateEngine(Number(charId)).restoreBuffer(entries);
  }

  if (cache.selectedCharId != null) {
    const selected = Number(cache.selectedCharId);
    if (me.value?.characters.some(char => char.id === selected)) {
      selectedCharId.value = selected;
    }
  }

  await nextTick();
  liveLogRef.value?.restore(cache.liveEntries);
  return true;
}

// Online status and fleet session derived from the app-level character status poller.
const isOnline = computed<boolean>(() => charStatus[selectedCharIdNum.value ?? 0]?.online === true);
const fleetInfo = computed<{ fleetId: string } | null>(() => {
  const session = charStatus[selectedCharIdNum.value ?? 0]?.session;
  return session ? { fleetId: session.id } : null;
});

onEntries(entries => {
  debugChar('onEntries:batch', {
    count: entries.length,
    selectedCharId: selectedCharId.value,
    selectedCharIdNum: selectedCharIdNum.value,
    selectedCharName: selectedCharName.value,
  });
  const chars = me.value?.characters ?? [];
  const charById = new Map(chars.map(c => [c.id, c]));
  const charByName = new Map(chars.map(c => [normalizeName(c.name), c]));

  const byCharId = new Map<number, LogEntry[]>();
  const byCharNorm = new Map<string, LogEntry[]>();
  for (const e of entries) {
    if (e.logOwnerId != null && Number.isFinite(e.logOwnerId)) {
      const ownerId = Number(e.logOwnerId);
      const arrById = byCharId.get(ownerId) ?? [];
      arrById.push(e);
      byCharId.set(ownerId, arrById);
      continue;
    }
    const ownerNorm = normalizeName(e.logOwner);
    const arr = byCharNorm.get(ownerNorm) ?? [];
    arr.push(e);
    byCharNorm.set(ownerNorm, arr);
  }

  debugChar('onEntries:routing', {
    knownCharIds: Array.from(charById.keys()),
    knownCharNames: Array.from(charByName.keys()),
    incomingByIdCount: byCharId.size,
    incomingByIdKeys: Array.from(byCharId.keys()),
    incomingByNameCount: byCharNorm.size,
    incomingByNameKeys: Array.from(byCharNorm.keys()),
  });

  const selectedId = selectedCharIdNum.value;
  const visibleEntries = selectedId != null
    ? (byCharId.get(selectedId)
      ?? byCharNorm.get(normalizeName(selectedCharName.value ?? ''))
      ?? entries)
    : entries;
  liveLogRef.value?.push(visibleEntries);

  const unmatchedIds: number[] = [];
  let matchedAnyOwner = false;
  for (const [ownerId, ownerEntries] of byCharId) {
    const char = charById.get(ownerId);
    if (char) {
      getOrCreateEngine(char.id).addEntries(ownerEntries);
      matchedAnyOwner = true;
    } else {
      unmatchedIds.push(ownerId);
    }
  }

  const unmatchedOwners: string[] = [];
  for (const [ownerNorm, ownerEntries] of byCharNorm) {
    const char = charByName.get(ownerNorm);
    if (char) {
      getOrCreateEngine(char.id).addEntries(ownerEntries);
      matchedAnyOwner = true;
    } else {
      unmatchedOwners.push(ownerNorm);
    }
  }

  if (unmatchedOwners.length) {
    debugChar('onEntries:unmatchedOwners', {
      unmatchedOwners,
      knownCharacters: chars.map(c => c.name),
    });
  }
  if (unmatchedIds.length) {
    debugChar('onEntries:unmatchedIds', {
      unmatchedIds,
      knownCharacterIds: chars.map(c => c.id),
    });
  }

  // Log which path visibleEntries took
  const visiblePath = selectedId != null
    ? (byCharId.has(selectedId) ? 'byId' : (byCharNorm.has(normalizeName(selectedCharName.value ?? '')) ? 'byName' : 'fallback'))
    : 'noSelection';
  debugChar('onEntries:visiblePath', { path: visiblePath, count: visibleEntries.length, selectedId });

  // Check engine state
  debugChar('onEntries:engines', {
    engineCharIds: Object.keys(charEngines).map(Number),
    selectedCharId: selectedCharIdNum.value,
    selectedEngine: charEngines[selectedCharIdNum.value ?? 0] ? {
      bufferLen: charEngines[selectedCharIdNum.value ?? 0].exportBuffer().length,
      snapshotType: typeof charEngines[selectedCharIdNum.value ?? 0].snapshot,
      snapshotValueType: typeof charEngines[selectedCharIdNum.value ?? 0].snapshot.value,
      dpsOut: charEngines[selectedCharIdNum.value ?? 0].snapshot.value?.dpsOut,
    } : null,
    charSnapshots_value: charSnapshots.value[selectedCharIdNum.value ?? 0],
    snap_value: snap.value,
  });

  void persistPilotSessionCache();

  if (isOnline.value && fleetInfo.value && selectedCharIdNum.value) uploadSnapshot();
});

// Upload snapshot to server every 2s via pilot route
const UPLOAD_INTERVAL_MS = parseInt(
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.PUBLIC_UPLOAD_INTERVAL_MS ?? '2000',
  10,
);
let uploadTimer: ReturnType<typeof setInterval> | null = null;

async function openLogs() {
  try {
    await openDirectory();
    await clearPilotSessionCache();
    syncOverviews(getAllOverviews());
  } catch (e: any) {
    if (e?.name !== 'AbortError') toast.add({ severity: 'error', summary: t('pilot.cannotOpenFolder'), detail: String(e), life: 4000 });
  }
}

async function stopAndForget() {
  await forgetDirectory();
  await clearPilotSessionCache();
  liveLogRef.value?.clear();
}

async function uploadSnapshot() {
  if (!snap.value || !fleetInfo.value || !selectedCharIdNum.value || !isOnline.value) return;
  try {
    await api.post('/api/pilot/data', {
      characterId: selectedCharIdNum.value,
      fleetSessionId: fleetInfo.value.fleetId,
      snapshot: snap.value,
    });
  } catch {
    // silently ignore upload errors
  }
}

watch(selectedCharIdNum, async (charId) => {
  if (!charId) return;
  debugChar('watch:selectedCharIdNum:timersReset', { charId });
  // Engines are persistent — do not clear historical view on switch.
  // Clear upload timer; it will be restarted below.
  if (uploadTimer) clearInterval(uploadTimer);
  uploadTimer = setInterval(uploadSnapshot, UPLOAD_INTERVAL_MS);
});

function logout() {
  api.post('/auth/logout', {}).then(() => {
    clearMeCache();
    window.location.href = '/auth/login';
  });
}

onMounted(async () => {
  try {
    me.value = await getMe();
    debugChar('onMounted:getMe', {
      characterCount: me.value.characters.length,
      characters: me.value.characters,
    });
    // Start app-level character status polling (deduplicates if App.vue already started it).
    startCharacterStatus(me.value);
    // Pre-create engines for ALL characters so all begin tracking immediately
    for (const char of me.value.characters) {
      getOrCreateEngine(char.id);
    }
    if (me.value.characters.length) {
      selectedCharId.value = me.value.characters[0].id;
    }
  } catch {
    clearMeCache();
    window.location.href = '/auth/login';
    return;
  }
  // Attempt to silently re-open the last log directory (no user prompt needed
  // if the browser still has permission for the stored handle).
  const restored = await tryRestoreDirectory();
  debugChar('onMounted:restoreDirectory', { restored });
  if (restored) {
    await restorePilotSessionCache();
    syncOverviews(getAllOverviews());
  }
});

onUnmounted(() => {
  void persistPilotSessionCache();
  if (uploadTimer) clearInterval(uploadTimer);
  stopLogs();
});
</script>

<style scoped>
/* ── EVE Online palette ───────────────────────────────────────────── */
:root {
  --eve-bg:       #0d0f14;
  --eve-panel:    #13181f;
  --eve-surface:  #1a2030;
  --eve-border:   #253048;
  --eve-gold:     #c8a84b;
  --eve-gold-dim: #8a6e2e;
  --eve-cyan:     #4fc3d1;
  --eve-text:     #cfd9ee;
  --eve-muted:    #5b6f8e;
}

.pilot-dashboard { display: flex; flex-direction: column; min-height: 100vh; background: var(--eve-bg); color: var(--eve-text); }
.char-select { min-width: 180px; }
.chart-setting-select { min-width: 180px; }
main { padding: 1rem 1.5rem; display: flex; flex-direction: column; gap: 1rem; }
.settings-bar { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
.fleet-badge {
  padding: 0.2rem 0.65rem;
  background: var(--eve-surface);
  border: 1px solid var(--eve-border);
  border-radius: 3px;
  font-size: 0.8rem;
  color: var(--eve-cyan);
}
.fleet-badge.muted { color: var(--eve-muted); border-color: transparent; }
.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  min-width: 0;
}
@media (max-width: 1200px) {
  .charts-grid { grid-template-columns: 1fr; }
}
.chart-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--eve-panel);
  border: 1px solid var(--eve-border);
  border-radius: 4px;
  min-width: 0;
}
.section-heading {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--eve-gold);
}
.bottom-row { display: grid; grid-template-columns: 1fr 300px; gap: 1rem; }
.live-log-section { margin-top: 0; }
.loading-state { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; opacity: 0.5; }
.log-loading-banner {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 1rem;
  background: #1a1e10;
  border: 1px solid #4a5e20;
  border-radius: 6px;
  color: #a8c050;
  font-size: 0.9rem;
}

/* Character dropdown option with online status */
.char-option {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.char-option-name {
  font-size: 0.88rem;
  color: #cfd9ee;
}
.char-option-status {
  font-size: 0.72rem;
}
.status-online  { color: #4ade80; }
.status-offline { color: #f87171; }
.status-unknown { color: #5b6f8e; font-style: italic; }

@media (max-width: 1200px) {
  main { padding: 1rem; }
}

@media (max-width: 900px) {
  .char-select { min-width: 140px; }
  .bottom-row { grid-template-columns: 1fr; }
}
</style>
