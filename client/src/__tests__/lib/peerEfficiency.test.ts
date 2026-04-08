import { describe, it, expect } from 'vitest';
import { computePeerEfficiency, MIN_ACTIVE_DPS } from '@/lib/peerEfficiency';
import { shipTypes } from '@/lib/shipTypes';

// Minimal resolveGroupId using the real shipTypes data
function resolveGroupId(shipTypeId: number): number | undefined {
  return shipTypes.get(shipTypeId)?.groupId;
}

// Helper: build a minimal member array for a given shipTypeId with given DPS values
function makeMemberSet(
  shipTypeId: number,
  dpsValues: number[],
  startId = 1,
): Array<{ characterId: number; shipTypeId: number; dpsOut: number }> {
  return dpsValues.map((dps, i) => ({
    characterId: startId + i,
    shipTypeId,
    dpsOut: dps,
  }));
}

// Rifter groupId=25 (Frigate), Merlin groupId=25, Slasher groupId=25
// Scimitar groupId=832 (Logistics)
const RIFTER_TYPE    = 587;  // groupId 25 (Frigate/combat)
const SLASHER_TYPE   = 585;  // groupId 25 (Frigate/combat) — same group, diff type
const SCIMITAR_TYPE  = 11978; // groupId 832 (Logistics)
const MERLIN_TYPE    = 603;   // groupId 25 (Frigate/combat)

describe('computePeerEfficiency', () => {
  it('5 pilots on same shipType → confidence=high, referenceSource=shipType', () => {
    const members = makeMemberSet(RIFTER_TYPE, [100, 200, 300, 400, 500]);
    const results = computePeerEfficiency(members, resolveGroupId);

    for (const r of results) {
      expect(r.confidenceLevel).toBe('high');
      expect(r.referenceSource).toBe('shipType');
      expect(r.efficiency).not.toBeNull();
    }
  });

  it('3 pilots on same shipType → confidence=low, referenceSource=shipType', () => {
    const members = makeMemberSet(RIFTER_TYPE, [100, 200, 300]);
    const results = computePeerEfficiency(members, resolveGroupId);

    for (const r of results) {
      expect(r.confidenceLevel).toBe('low');
      expect(r.referenceSource).toBe('shipType');
    }
  });

  it('2 pilots on same shipType → fallback to groupId with enough peers', () => {
    // 2 Rifters + 5 Slashers (same groupId=25) → Rifters fallback to group
    const rifters  = makeMemberSet(RIFTER_TYPE,  [100, 200],           1);
    const slashers = makeMemberSet(SLASHER_TYPE, [150, 250, 350, 450, 550], 10);
    const members  = [...rifters, ...slashers];
    const results  = computePeerEfficiency(members, resolveGroupId);

    // Rifter pilots should fall back to groupId reference
    const rifterResults = results.filter(r => r.characterId < 10);
    for (const r of rifterResults) {
      expect(r.referenceSource).toBe('shipGroup');
      expect(r.confidenceLevel).toBe('low');
    }
  });

  it('1 pilot with unique shipType and not enough group peers → efficiency=null', () => {
    // Only 1 pilot, no group peers
    const members = [{ characterId: 1, shipTypeId: RIFTER_TYPE, dpsOut: 300 }];
    const results = computePeerEfficiency(members, resolveGroupId);

    expect(results[0].efficiency).toBeNull();
    expect(results[0].confidenceLevel).toBe('none');
    expect(results[0].referenceSource).toBeNull();
  });

  it('logistics pilot → efficiency=null regardless of fleet size', () => {
    const scimitars = makeMemberSet(SCIMITAR_TYPE, [100, 200, 300, 400, 500, 600]);
    const results   = computePeerEfficiency(scimitars, resolveGroupId);

    for (const r of results) {
      expect(r.efficiency).toBeNull();
      expect(r.referenceDps).toBeNull();
      expect(r.role).toBe('logistics');
    }
  });

  it('combat pilot with dpsOut=0 → isZeroDps=true', () => {
    // Need enough peers so the pilot gets a reference
    const members = makeMemberSet(RIFTER_TYPE, [0, 200, 300, 400, 500]);
    const results = computePeerEfficiency(members, resolveGroupId);

    const zeroPilot = results.find(r => r.dpsOut === 0)!;
    expect(zeroPilot.isZeroDps).toBe(true);
  });

  it('efficiency >1.0 is not capped', () => {
    // Reference (upper-half median) will be around 100-200
    // The outlier pilot with 9999 DPS should get efficiency >> 1
    const members = makeMemberSet(RIFTER_TYPE, [100, 150, 200, 250, 9999]);
    const results = computePeerEfficiency(members, resolveGroupId);

    const topPilot = results.find(r => r.dpsOut === 9999)!;
    expect(topPilot.efficiency).not.toBeNull();
    expect(topPilot.efficiency!).toBeGreaterThan(1.0);
  });

  it('30 pilots, 5 AFK (dpsOut < MIN_ACTIVE_DPS) → AFK excluded from reference line', () => {
    // 25 active at 300 DPS, 5 AFK at 0 DPS
    const active = Array.from({ length: 25 }, (_, i) => ({
      characterId: i + 1,
      shipTypeId: RIFTER_TYPE,
      dpsOut: 300,
    }));
    const afk = Array.from({ length: 5 }, (_, i) => ({
      characterId: 100 + i,
      shipTypeId: RIFTER_TYPE,
      dpsOut: 0,
    }));
    const members = [...active, ...afk];
    const results = computePeerEfficiency(members, resolveGroupId);

    // With all actives at 300, the upper-half median should be 300
    // AFK pilots should have isZeroDps=true and efficiency=0/300=0
    const activePilots = results.filter(r => r.dpsOut >= MIN_ACTIVE_DPS);
    const afkPilots    = results.filter(r => r.dpsOut < MIN_ACTIVE_DPS && r.role === 'combat');

    for (const r of activePilots) {
      expect(r.referenceDps).toBe(300);
      expect(r.efficiency).toBeCloseTo(1.0, 5);
    }
    for (const r of afkPilots) {
      expect(r.isZeroDps).toBe(true);
      // Reference still computed (from active peers), but their own efficiency = 0
      expect(r.referenceDps).toBe(300);
    }
  });

  it('pilot with dpsOut=3 is excluded from reference sample (below MIN_ACTIVE_DPS)', () => {
    // 4 pilots at 3 DPS (below threshold) + 5 at 200 DPS
    // Reference should come from the 5 active pilots only → should be high confidence
    const low    = Array.from({ length: 4 }, (_, i) => ({
      characterId: i + 1,
      shipTypeId: RIFTER_TYPE,
      dpsOut: 3,
    }));
    const active = Array.from({ length: 5 }, (_, i) => ({
      characterId: 10 + i,
      shipTypeId: RIFTER_TYPE,
      dpsOut: 200,
    }));
    const members = [...low, ...active];
    const results = computePeerEfficiency(members, resolveGroupId);

    // Reference should only use the 5 active pilots → high confidence
    for (const r of results) {
      expect(r.confidenceLevel).toBe('high');
    }
    // Active pilots have 200 DPS, upper-half median of [200,200,200,200,200] = 200
    const activePilots = results.filter(r => r.dpsOut === 200);
    for (const r of activePilots) {
      expect(r.referenceDps).toBe(200);
    }
    // Low-DPS pilots have efficiency = 3/200 = 0.015
    const lowPilots = results.filter(r => r.dpsOut === 3);
    for (const r of lowPilots) {
      expect(r.efficiency).toBeCloseTo(3 / 200, 5);
    }
  });
});
