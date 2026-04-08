import { describe, it, expect } from 'vitest';
import { computeFleetAggregate, computeWarAggregate, type PilotSnapshot, type MemberSnapshot } from '../../lib/aggregate.js';

describe('computeFleetAggregate', () => {
  it('sums numeric fields across snapshots', () => {
    const snapshots: PilotSnapshot[] = [
      { characterId: 1, dpsOut: 100, dpsIn: 50, logiOut: 0, logiIn: 0 },
      { characterId: 2, dpsOut: 200, dpsIn: 30, logiOut: 10, logiIn: 0 },
    ];
    const agg = computeFleetAggregate(snapshots);
    expect(agg.memberCount).toBe(2);
    expect(agg.dpsOut).toBe(300);
    expect(agg.dpsIn).toBe(80);
    expect(agg.logiOut).toBe(10);
  });

  it('merges hit quality distributions', () => {
    const snapshots: PilotSnapshot[] = [
      { characterId: 1, hitQualityDistribution: { 'Wrecks': 5, 'Grazes': 2 } },
      { characterId: 2, hitQualityDistribution: { 'Wrecks': 3, 'Penetrates': 1 } },
    ];
    const agg = computeFleetAggregate(snapshots);
    expect(agg.hitQualityDistribution).toEqual({ 'Wrecks': 8, 'Grazes': 2, 'Penetrates': 1 });
  });

  it('caps breakdown at MAX_BREAKDOWN_ENTRIES', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ amount: i, weaponType: `weapon_${i}` }));
    const snapshots: PilotSnapshot[] = [{ characterId: 1, breakdown: entries }];
    const agg = computeFleetAggregate(snapshots);
    expect(agg.breakdown.length).toBeLessThanOrEqual(20);
    expect(agg.breakdown[0].amount).toBe(29);
  });

  it('handles empty snapshot array', () => {
    const agg = computeFleetAggregate([]);
    expect(agg.memberCount).toBe(0);
    expect(agg.dpsOut).toBe(0);
  });

  it('handles snapshots with missing optional fields', () => {
    const snapshots: PilotSnapshot[] = [{ characterId: 1 }, { characterId: 2 }];
    const agg = computeFleetAggregate(snapshots);
    expect(agg.dpsOut).toBe(0);
    expect(agg.memberCount).toBe(2);
  });

  it('memberSnapshots contains all MemberSnapshot fields', () => {
    const snapshots: PilotSnapshot[] = [
      {
        characterId: 42,
        dpsOut: 100, dpsIn: 50,
        logiOut: 20, logiIn: 10,
        capTransfered: 5, capRecieved: 3,
        capDamageOut: 80, capDamageIn: 40,
        mined: 0,
        shipTypeId: 12345,
        solarSystemId: 30000142,
        hitQualityDistribution: { 'Wrecks': 4, 'Grazes': 1 },
        hitQualityDistributionIn: { 'Penetrates': 2 },
      },
    ];
    const agg = computeFleetAggregate(snapshots);
    const snap = agg.memberSnapshots[42] as MemberSnapshot;
    expect(snap).toBeDefined();
    expect(snap.dpsOut).toBe(100);
    expect(snap.dpsIn).toBe(50);
    expect(snap.logiOut).toBe(20);
    expect(snap.logiIn).toBe(10);
    expect(snap.capTransfered).toBe(5);
    expect(snap.capRecieved).toBe(3);
    expect(snap.capDamageOut).toBe(80);
    expect(snap.capDamageIn).toBe(40);
    expect(snap.mined).toBe(0);
    expect(snap.shipTypeId).toBe(12345);
    expect(snap.solarSystemId).toBe(30000142);
    expect(snap.hitQualityDistribution).toEqual({ 'Wrecks': 4, 'Grazes': 1 });
    expect(snap.hitQualityDistributionIn).toEqual({ 'Penetrates': 2 });
  });
});

describe('computeWarAggregate', () => {
  it('includes hitQualityDistributionIn merged from all fleets', () => {
    const fleet1 = computeFleetAggregate([
      { characterId: 1, hitQualityDistributionIn: { 'Wrecks': 3, 'Grazes': 1 } },
    ]);
    const fleet2 = computeFleetAggregate([
      { characterId: 2, hitQualityDistributionIn: { 'Wrecks': 2, 'Penetrates': 5 } },
    ]);
    const war = computeWarAggregate([fleet1, fleet2]);
    expect(war.hitQualityDistributionIn).toEqual({ 'Wrecks': 5, 'Grazes': 1, 'Penetrates': 5 });
  });

  it('merges memberSnapshots from all fleets', () => {
    const fleet1 = computeFleetAggregate([
      { characterId: 10, dpsOut: 200 },
    ]);
    const fleet2 = computeFleetAggregate([
      { characterId: 20, dpsOut: 150 },
    ]);
    const war = computeWarAggregate([fleet1, fleet2]);
    expect(war.memberSnapshots).toBeDefined();
    const snaps = war.memberSnapshots as Record<number, MemberSnapshot>;
    expect(snaps[10]).toBeDefined();
    expect(snaps[10].dpsOut).toBe(200);
    expect(snaps[20]).toBeDefined();
    expect(snaps[20].dpsOut).toBe(150);
  });
});
