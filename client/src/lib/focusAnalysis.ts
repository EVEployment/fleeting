export interface TargetEntry {
  targetName: string;
  totalAmount: number;
  pilotCount: number;
  share: number;
}

export interface FocusResult {
  focusTarget: string | null;
  focusShare: number;
  effectiveTargets: number;
  coverage: number;
  targetBreakdown: TargetEntry[];
}

type BreakdownLike = {
  targetName?: string;
  amount: number;
  pilotName?: string;
  [key: string]: unknown;
};

export function computeFocus(
  breakdown: BreakdownLike[],
  totalDpsOut: number,
): FocusResult {
  // Group by targetName, filtering out entries with no target
  const targetMap = new Map<string, { totalAmount: number; pilots: Set<string> }>();
  let representedTotal = 0;

  for (const entry of breakdown) {
    if (!entry.targetName) continue;
    representedTotal += entry.amount;

    let bucket = targetMap.get(entry.targetName);
    if (!bucket) {
      bucket = { totalAmount: 0, pilots: new Set() };
      targetMap.set(entry.targetName, bucket);
    }
    bucket.totalAmount += entry.amount;
    if (entry.pilotName) bucket.pilots.add(entry.pilotName);
  }

  const coverage = totalDpsOut > 0 ? representedTotal / totalDpsOut : 0;

  // Build TargetEntry list sorted by totalAmount descending
  const targetBreakdown: TargetEntry[] = [];
  for (const [targetName, { totalAmount, pilots }] of targetMap) {
    targetBreakdown.push({
      targetName,
      totalAmount,
      pilotCount: pilots.size,
      share: representedTotal > 0 ? totalAmount / representedTotal : 0,
    });
  }
  targetBreakdown.sort((a, b) => b.totalAmount - a.totalAmount);

  // effectiveTargets = 1 / Σ(share²)
  const sumShareSq = targetBreakdown.reduce((s, t) => s + t.share * t.share, 0);
  const effectiveTargets = sumShareSq > 0 ? 1 / sumShareSq : 0;

  const focusTarget = targetBreakdown.length > 0 ? targetBreakdown[0].targetName : null;
  const focusShare = targetBreakdown.length > 0 ? targetBreakdown[0].share : 0;

  return { focusTarget, focusShare, effectiveTargets, coverage, targetBreakdown };
}
