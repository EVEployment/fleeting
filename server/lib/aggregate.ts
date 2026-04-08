const NUMERIC_FIELDS = [
  'dpsOut', 'dpsIn', 'logiOut', 'logiIn',
  'capTransfered', 'capRecieved', 'capDamageOut', 'capDamageIn', 'mined',
] as const;

type NumericField = (typeof NUMERIC_FIELDS)[number];

const MAX_BREAKDOWN_ENTRIES = parseInt(process.env.BREAKDOWN_MAX_ENTRIES ?? '20', 10);

export interface BreakdownEntry {
  pilotName?:  string;
  weaponType?: string;
  shipType?:   string;
  targetName?: string;
  category?:   string;
  amount:      number;
  hits?:       number;
  hitQuality?: string | null;
  [key: string]: unknown;
}

export interface PilotSnapshot {
  characterId?: number;
  shipTypeId?: number;
  solarSystemId?: number;
  hitQualityDistribution?: Record<string, number>;
  hitQualityDistributionIn?: Record<string, number>;
  breakdown?: BreakdownEntry[];
  dpsOut?: number;
  dpsIn?: number;
  logiOut?: number;
  logiIn?: number;
  capTransfered?: number;
  capRecieved?: number;
  capDamageOut?: number;
  capDamageIn?: number;
  mined?: number;
}

export interface MemberSnapshot {
  dpsOut?: number; dpsIn?: number;
  logiOut?: number; logiIn?: number;
  capTransfered?: number; capRecieved?: number;
  capDamageOut?: number; capDamageIn?: number;
  mined?: number;
  shipTypeId?: number; solarSystemId?: number;
  hitQualityDistribution?: Record<string, number>;
  hitQualityDistributionIn?: Record<string, number>;
}

export interface FleetAggregate {
  memberCount: number;
  dpsOut: number; dpsIn: number; logiOut: number; logiIn: number;
  capTransfered: number; capRecieved: number;
  capDamageOut: number; capDamageIn: number; mined: number;
  hitQualityDistribution: Record<string, number>;
  hitQualityDistributionIn: Record<string, number>;
  breakdown: BreakdownEntry[];
  memberSnapshots: Record<number, MemberSnapshot>;
  fleetSessionId?: string;
}

export function computeFleetAggregate(snapshots: PilotSnapshot[]): FleetAggregate {
  const agg: FleetAggregate = {
    memberCount: snapshots.length,
    dpsOut: 0, dpsIn: 0, logiOut: 0, logiIn: 0,
    capTransfered: 0, capRecieved: 0, capDamageOut: 0, capDamageIn: 0, mined: 0,
    hitQualityDistribution: {},
    hitQualityDistributionIn: {},
    breakdown: [],
    memberSnapshots: {},
  };

  for (const snap of snapshots) {
    for (const field of NUMERIC_FIELDS) {
      (agg[field] as number) += (snap[field] as number | undefined) ?? 0;
    }
    if (snap.hitQualityDistribution) {
      for (const [qual, count] of Object.entries(snap.hitQualityDistribution)) {
        agg.hitQualityDistribution[qual] = (agg.hitQualityDistribution[qual] ?? 0) + count;
      }
    }
    if (snap.hitQualityDistributionIn) {
      for (const [qual, count] of Object.entries(snap.hitQualityDistributionIn)) {
        agg.hitQualityDistributionIn[qual] = (agg.hitQualityDistributionIn[qual] ?? 0) + count;
      }
    }
    if (Array.isArray(snap.breakdown)) {
      agg.breakdown.push(...snap.breakdown);
    }
    if (snap.characterId != null) {
      agg.memberSnapshots[snap.characterId] = {
        dpsOut: snap.dpsOut, dpsIn: snap.dpsIn,
        logiOut: snap.logiOut, logiIn: snap.logiIn,
        capTransfered: snap.capTransfered, capRecieved: snap.capRecieved,
        capDamageOut: snap.capDamageOut, capDamageIn: snap.capDamageIn,
        mined: snap.mined,
        shipTypeId: snap.shipTypeId, solarSystemId: snap.solarSystemId,
        hitQualityDistribution: snap.hitQualityDistribution ?? {},
        hitQualityDistributionIn: snap.hitQualityDistributionIn ?? {},
      };
    }
  }

  agg.breakdown.sort((a, b) => b.amount - a.amount);
  if (agg.breakdown.length > MAX_BREAKDOWN_ENTRIES) {
    agg.breakdown = agg.breakdown.slice(0, MAX_BREAKDOWN_ENTRIES);
  }
  return agg;
}

export function computeWarAggregate(fleetAggregates: FleetAggregate[]) {
  const war = {
    fleetCount: fleetAggregates.length,
    memberCount: 0,
    dpsOut: 0, dpsIn: 0, logiOut: 0, logiIn: 0,
    capTransfered: 0, capRecieved: 0, capDamageOut: 0, capDamageIn: 0, mined: 0,
    hitQualityDistribution: {} as Record<string, number>,
    hitQualityDistributionIn: {} as Record<string, number>,
    breakdown: [] as BreakdownEntry[],
    fleetBreakdown: [] as unknown[],
    memberSnapshots: {} as Record<number, MemberSnapshot>,
  };

  for (const fa of fleetAggregates) {
    war.memberCount += fa.memberCount ?? 0;
    for (const field of NUMERIC_FIELDS) {
      (war[field] as number) += (fa[field] as number | undefined) ?? 0;
    }
    for (const [qual, count] of Object.entries(fa.hitQualityDistribution ?? {})) {
      war.hitQualityDistribution[qual] = (war.hitQualityDistribution[qual] ?? 0) + count;
    }
    for (const [qual, count] of Object.entries(fa.hitQualityDistributionIn ?? {})) {
      war.hitQualityDistributionIn[qual] = (war.hitQualityDistributionIn[qual] ?? 0) + count;
    }
    war.breakdown.push(...(fa.breakdown ?? []));
    war.fleetBreakdown.push({
      fleetSessionId: fa.fleetSessionId,
      dpsOut:         fa.dpsOut,
      memberCount:    fa.memberCount,
    });
    Object.assign(war.memberSnapshots, fa.memberSnapshots ?? {});
  }

  war.breakdown.sort((a, b) => b.amount - a.amount);
  if (war.breakdown.length > MAX_BREAKDOWN_ENTRIES) {
    war.breakdown = war.breakdown.slice(0, MAX_BREAKDOWN_ENTRIES);
  }
  return war;
}
