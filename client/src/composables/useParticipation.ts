/**
 * useParticipation.ts
 *
 * Detects non-participants from the latest member_presence snapshot.
 *
 * Two signals:
 *  1. Non-combat ship: ship_type_id's groupId ∈ NON_COMBAT_GROUP_IDS
 *  2. Location outlier: member in a different solar system than the fleet majority
 *     for ≥2 consecutive presence readings (60s)
 */

import { computed } from 'vue';
import type { Ref } from 'vue';
import { shipTypes } from '../lib/shipTypes';
import { classifyShipRole, isNonCombat } from '../lib/shipRoles';

export interface PresenceRecord {
  characterId:   number;
  solarSystemId: number;
  shipTypeId:    number;
}

export type NonParticipantReason = 'location' | 'ship' | 'both';

export interface NonParticipant {
  characterId: number;
  reason:      NonParticipantReason;
}

export interface ParticipationResult {
  participatingMembers: number[];
  nonParticipants:      NonParticipant[];
}

/**
 * presenceHistory: latest TWO snapshots per member (ordered oldest first)
 * so we can check ≥2 consecutive readings in different system.
 */
export function useParticipation(
  presenceHistory: Ref<PresenceRecord[][]>,
) {
  const result = computed<ParticipationResult>(() => {
    const snapshots = presenceHistory.value;
    if (!snapshots || snapshots.length < 1) {
      return { participatingMembers: [], nonParticipants: [] };
    }

    // Latest snapshot for system mode
    const latest = snapshots[snapshots.length - 1] ?? [];

    // Compute mode solar system (most common among latest snapshot)
    const systemCounts = new Map<number, number>();
    for (const m of latest) {
      systemCounts.set(m.solarSystemId, (systemCounts.get(m.solarSystemId) ?? 0) + 1);
    }
    let modeSystem = -1;
    let modeCount  = 0;
    for (const [sys, cnt] of systemCounts) {
      if (cnt > modeCount) { modeCount = cnt; modeSystem = sys; }
    }

    // Previous snapshot (if available) for consecutive outlier check
    const prev = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
    const prevMap = new Map<number, number>();
    if (prev) {
      for (const m of prev) prevMap.set(m.characterId, m.solarSystemId);
    }

    const nonParticipants: NonParticipant[] = [];
    const participating:   number[]         = [];

    for (const m of latest) {
      const shipInfo  = shipTypes.get(m.shipTypeId);
      const isNonCombatShip = shipInfo
        ? isNonCombat(classifyShipRole(shipInfo.groupId))
        : false;

      // Location outlier: different system in both latest and previous readings
      const prevSystem = prevMap.get(m.characterId);
      const isOutlier  = modeSystem !== -1
        && m.solarSystemId !== modeSystem
        && (prev === null || prevSystem === undefined || prevSystem !== modeSystem);

      if (isNonCombatShip && isOutlier) {
        nonParticipants.push({ characterId: m.characterId, reason: 'both' });
      } else if (isNonCombatShip) {
        nonParticipants.push({ characterId: m.characterId, reason: 'ship' });
      } else if (isOutlier) {
        nonParticipants.push({ characterId: m.characterId, reason: 'location' });
      } else {
        participating.push(m.characterId);
      }
    }

    return { participatingMembers: participating, nonParticipants };
  });

  return result;
}
