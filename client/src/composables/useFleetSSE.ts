/**
 * useFleetSSE.ts
 *
 * Subscribes to a Nchan SSE channel and provides the latest fleet aggregate.
 * Supports multiplexed channels (War Cmdr: id1,id2,id3).
 * Auto-reconnects on disconnect with exponential backoff.
 */

import { ref, reactive, watch, onUnmounted, type Ref } from 'vue';

export interface MemberSnapshot {
  dpsOut?:                    number;
  dpsIn?:                     number;
  logiOut?:                   number;
  logiIn?:                    number;
  capTransfered?:             number;
  capRecieved?:               number;
  capDamageOut?:              number;
  capDamageIn?:               number;
  mined?:                     number;
  shipTypeId?:                number;
  solarSystemId?:             number;
  hitQualityDistribution?:    Record<string, number>;
  hitQualityDistributionIn?:  Record<string, number>;
}

export interface FleetAggregate {
  fleetSessionId: string;
  dpsOut:         number;
  dpsIn:          number;
  logiOut:        number;
  logiIn:         number;
  capTransfered:  number;
  capRecieved:    number;
  capDamageOut:   number;
  capDamageIn:    number;
  mined:          number;
  memberCount:    number;
  hitQualityDistribution:   Record<string, number>;
  hitQualityDistributionIn: Record<string, number>;
  breakdown:      any[];
  memberSnapshots?: Record<string, MemberSnapshot>;
}

function mergeFleetAggregates(fleets: FleetAggregate[]): FleetAggregate {
  if (fleets.length === 0) {
    return {
      fleetSessionId: '', dpsOut: 0, dpsIn: 0, logiOut: 0, logiIn: 0,
      capTransfered: 0, capRecieved: 0, capDamageOut: 0, capDamageIn: 0,
      mined: 0, memberCount: 0, hitQualityDistribution: {},
      hitQualityDistributionIn: {}, breakdown: [], memberSnapshots: {},
    };
  }
  if (fleets.length === 1) return fleets[0];

  const merged: FleetAggregate = {
    fleetSessionId:           fleets.map(f => f.fleetSessionId).join(','),
    dpsOut: 0, dpsIn: 0, logiOut: 0, logiIn: 0,
    capTransfered: 0, capRecieved: 0, capDamageOut: 0, capDamageIn: 0,
    mined: 0, memberCount: 0,
    hitQualityDistribution:   {},
    hitQualityDistributionIn: {},
    breakdown:                [],
    memberSnapshots:          {},
  };

  for (const fa of fleets) {
    merged.dpsOut        += fa.dpsOut        ?? 0;
    merged.dpsIn         += fa.dpsIn         ?? 0;
    merged.logiOut       += fa.logiOut       ?? 0;
    merged.logiIn        += fa.logiIn        ?? 0;
    merged.capTransfered += fa.capTransfered ?? 0;
    merged.capRecieved   += fa.capRecieved   ?? 0;
    merged.capDamageOut  += fa.capDamageOut  ?? 0;
    merged.capDamageIn   += fa.capDamageIn   ?? 0;
    merged.mined         += fa.mined         ?? 0;
    merged.memberCount   += fa.memberCount   ?? 0;

    for (const [q, c] of Object.entries(fa.hitQualityDistribution ?? {})) {
      merged.hitQualityDistribution[q] = (merged.hitQualityDistribution[q] ?? 0) + c;
    }
    for (const [q, c] of Object.entries(fa.hitQualityDistributionIn ?? {})) {
      merged.hitQualityDistributionIn[q] = (merged.hitQualityDistributionIn[q] ?? 0) + c;
    }

    merged.breakdown.push(...(fa.breakdown ?? []));
    Object.assign(merged.memberSnapshots!, fa.memberSnapshots ?? {});
  }

  merged.breakdown.sort((a, b) => b.amount - a.amount);
  if (merged.breakdown.length > 20) {
    merged.breakdown = merged.breakdown.slice(0, 20);
  }

  return merged;
}

export function useFleetSSE(channelIds: Ref<string[]>) {
  const aggregate   = ref<FleetAggregate | null>(null);
  const connected   = ref(false);
  const error       = ref<string | null>(null);
  const perFleet    = reactive(new Map<string, FleetAggregate>());
  let   evtSource:  EventSource | null = null;
  let   retryTimer: ReturnType<typeof setTimeout> | null = null;
  let   retryDelay  = 1000;

  function connect() {
    if (!channelIds.value.length) return;
    const ids = channelIds.value.join(',');
    const url = `/sub/fleet/${encodeURIComponent(ids)}`;

    evtSource = new EventSource(url);

    evtSource.onopen = () => {
      connected.value = true;
      error.value     = null;
      retryDelay      = 1000;
    };

    evtSource.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as FleetAggregate;
        perFleet.set(data.fleetSessionId, data);
        aggregate.value = mergeFleetAggregates([...perFleet.values()]);
      } catch {
        // Ignore malformed messages
      }
    };

    evtSource.onerror = () => {
      connected.value = false;
      evtSource?.close();
      evtSource = null;
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryDelay = Math.min(retryDelay * 2, 30_000);
      connect();
    }, retryDelay);
  }

  function disconnect() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    evtSource?.close();
    evtSource = null;
    connected.value = false;
    perFleet.clear();
  }

  onUnmounted(disconnect);

  // Auto-connect/reconnect whenever channelIds changes.
  watch(channelIds, (ids) => {
    disconnect();
    if (ids.length) connect();
  }, { immediate: true });

  return { aggregate, connected, error, connect, disconnect };
}
