/**
 * peerEfficiency.ts — Peer-based DPS efficiency computation for EVE fleet analysis.
 *
 * Context: computes each pilot's DPS relative to a reference baseline derived
 * from same-ship-type or same-group peers. Uses upper-half median to avoid
 * AFK anchors pulling down the reference.
 */

import type { MemberSnapshot } from '../composables/useFleetSSE';
import { classifyShipRole, isDpsExpected, type ShipRole } from './shipRoles';

/** Pilots below this DPS threshold are considered "not outputting" and excluded
 *  from reference line calculations. */
export const MIN_ACTIVE_DPS = 5;

export interface PilotEfficiency {
  characterId:      number;
  role:             ShipRole;
  dpsOut:           number;
  referenceDps:     number | null;
  /** 0–1.5+, null when no reference available */
  efficiency:       number | null;
  confidenceLevel:  'high' | 'low' | 'none';
  /** How the reference was derived */
  referenceSource:  'shipType' | 'shipGroup' | null;
  /** true when DPS is expected but pilot is below MIN_ACTIVE_DPS */
  isZeroDps:        boolean;
}

function median(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Compute upper-half median of a sorted (ascending) array of active DPS values.
 * "Active" means >= MIN_ACTIVE_DPS.
 */
function upperHalfMedian(activeDpsValues: number[]): number {
  const sorted = [...activeDpsValues].sort((a, b) => a - b);
  const topHalf = sorted.slice(Math.ceil(sorted.length / 2));
  return median(topHalf);
}

export function computePeerEfficiency(
  members: Array<{ characterId: number } & MemberSnapshot>,
  resolveGroupId: (shipTypeId: number) => number | undefined,
): PilotEfficiency[] {
  // Pre-compute role and groupId for each member
  const enriched = members.map((m) => {
    const groupId = m.shipTypeId !== undefined ? resolveGroupId(m.shipTypeId) : undefined;
    const role    = groupId !== undefined ? classifyShipRole(groupId) : 'combat' as ShipRole;
    const dpsOut  = m.dpsOut ?? 0;
    return { ...m, groupId, role, dpsOut };
  });

  // Index active DPS values by shipTypeId and groupId
  // Only pilots with dpsOut >= MIN_ACTIVE_DPS are used as reference samples
  const activeByShipType = new Map<number, number[]>();
  const activeByGroup    = new Map<number, number[]>();

  for (const m of enriched) {
    if (!isDpsExpected(m.role)) continue;
    if (m.dpsOut < MIN_ACTIVE_DPS) continue;
    if (m.shipTypeId !== undefined) {
      if (!activeByShipType.has(m.shipTypeId)) activeByShipType.set(m.shipTypeId, []);
      activeByShipType.get(m.shipTypeId)!.push(m.dpsOut);
    }
    if (m.groupId !== undefined) {
      if (!activeByGroup.has(m.groupId)) activeByGroup.set(m.groupId, []);
      activeByGroup.get(m.groupId)!.push(m.dpsOut);
    }
  }

  return enriched.map((m): PilotEfficiency => {
    const dpsOut    = m.dpsOut;
    const isZeroDps = isDpsExpected(m.role) && dpsOut < MIN_ACTIVE_DPS;

    // Non-combat roles (logistics, command, tackle, ewar, support, non-combat)
    // are not expected to deal damage — skip efficiency calculation entirely.
    if (!isDpsExpected(m.role)) {
      return {
        characterId:     m.characterId,
        role:            m.role,
        dpsOut,
        referenceDps:    null,
        efficiency:      null,
        confidenceLevel: 'none',
        referenceSource: null,
        isZeroDps,
      };
    }

    // Reference DPS fallback chain:
    // 1. same shipTypeId, >= 5 active pilots → high confidence
    // 2. same shipTypeId, 3–4 active pilots → low confidence
    // 3. same groupId, >= 5 active pilots → low confidence
    // 4. no reference

    let referenceDps:    number | null = null;
    let confidenceLevel: 'high' | 'low' | 'none' = 'none';
    let referenceSource: 'shipType' | 'shipGroup' | null = null;

    const typeId   = m.shipTypeId;
    const groupId  = m.groupId;

    if (typeId !== undefined) {
      const typePeers = activeByShipType.get(typeId) ?? [];
      if (typePeers.length >= 5) {
        referenceDps    = upperHalfMedian(typePeers);
        confidenceLevel = 'high';
        referenceSource = 'shipType';
      } else if (typePeers.length >= 3) {
        referenceDps    = upperHalfMedian(typePeers);
        confidenceLevel = 'low';
        referenceSource = 'shipType';
      }
    }

    if (referenceDps === null && groupId !== undefined) {
      const groupPeers = activeByGroup.get(groupId) ?? [];
      if (groupPeers.length >= 5) {
        referenceDps    = upperHalfMedian(groupPeers);
        confidenceLevel = 'low';
        referenceSource = 'shipGroup';
      }
    }

    const efficiency = referenceDps !== null && referenceDps > 0
      ? dpsOut / referenceDps
      : null;

    return {
      characterId:     m.characterId,
      role:            m.role,
      dpsOut,
      referenceDps,
      efficiency,
      confidenceLevel,
      referenceSource,
      isZeroDps,
    };
  });
}
