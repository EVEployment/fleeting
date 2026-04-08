/**
 * nonCombatGroups.ts — Set of EVE Online ship group IDs considered non-combat.
 *
 * @deprecated Use {@link shipRoles.ts} classifyShipRole() + isNonCombat() instead.
 * This file is retained for backward compatibility only. shipRoles.ts is the
 * single source of truth for ship role classification.
 */

export const NON_COMBAT_GROUP_IDS: ReadonlySet<number> = new Set([
  29,   // Capsule (Pod)
  31,   // Shuttle
  22,   // Industrial
  380,  // Transport Ship
  513,  // Freighter
  902,  // Jump Freighter
  463,  // Mining Barge
  543,  // Exhumer
  941,  // Industrial Command Ship (Orca, Porpoise)
  1022, // Mining Frigate
  237,  // Electronic Attack Ship (recon — debatable; kept here as safe default)
  1,    // Rookie Ship (Ibis, Velator, etc.)
]);
