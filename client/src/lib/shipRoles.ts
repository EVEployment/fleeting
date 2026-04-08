/**
 * shipRoles.ts — Single source of truth for EVE Online ship role classification.
 *
 * Context: used by peerEfficiency.ts to determine whether a pilot is expected
 * to deal damage, and to categorize pilots for fleet analysis.
 *
 * groupId values are from shipTypes.ts / EVE SDE.
 */

export type ShipRole =
  | 'combat'
  | 'logistics'
  | 'command'
  | 'tackle'
  | 'ewar'
  | 'support'
  | 'non-combat';

// Logistics: dedicated remote-repair ships
const LOGISTICS_GROUPS = new Set([
  832,  // Logistics (Scimitar, Basilisk, Guardian, Oneiros)
  1527, // Logistics Frigate (Deacon, Kirin, Thalia, Scalpel)
  1538, // Force Auxiliary (Apostle, Minokawa, Lif, Ninazu, Loggerhead)
]);

// Command: fleet boosting ships
const COMMAND_GROUPS = new Set([
  540,  // Command Ship (Eos, Sleipnir, Vulture, Absolution, Astarte, Claymore, Nighthawk, Damnation)
  1534, // Command Destroyer (Bifrost, Pontifex, Stork, Magus, Draugur, Outrider)
]);

// Tackle: dedicated tackle/interdiction
const TACKLE_GROUPS = new Set([
  541,  // Interdictor (Heretic, Sabre, Eris, Flycatcher)
  894,  // Heavy Interdiction Cruiser (Onyx, Broadsword, Devoter, Phobos, Fiend, Laelaps)
]);

// EWAR: dedicated electronic warfare
const EWAR_GROUPS = new Set([
  893,  // Electronic Attack Ship (Keres, Sentinel, Kitsune, Hyena, Raiju)
  906,  // Combat Recon Ship (Rook, Huginn, Lachesis, Curse)
  833,  // Force Recon Ship (Falcon, Rapier, Pilgrim, Arazu — cloak/EWAR focused)
]);

// Support: industrial, mining, logistics-adjacent non-combat
const SUPPORT_GROUPS = new Set([
  28,   // Hauler / Industrial
  380,  // Deep Space Transport
  513,  // Freighter
  902,  // Jump Freighter
  463,  // Mining Barge
  543,  // Exhumer
  941,  // Industrial Command Ship (Orca, Porpoise)
  883,  // Capital Industrial Ship (Rorqual)
  1022, // Prototype Exploration Ship / Mining Frigate (Zephyr)
  1202, // Blockade Runner
  1283, // Expedition Frigate (Prospect, Endurance)
  4902, // Expedition Command Ship (Odysseus)
  5087, // Special Edition Yachts
]);

// Non-combat: pods, shuttles, rookie ships
const NON_COMBAT_GROUPS = new Set([
  29,   // Capsule (Pod)
  31,   // Shuttle
  237,  // Corvette / Rookie Ship (Ibis, Velator, Reaper, Impairor, etc.)
  1,    // Rookie Ship (legacy groupId in nonCombatGroups.ts)
]);

// Combat: all remaining groups (including sub-caps, capitals, supers)
// Includes: Frigate(25), Destroyer(420), Cruiser(26), Battlecruiser(419),
// Attack Battlecruiser(1201), Battleship(27), HAC(358), Assault Frigate(324),
// Strategic Cruiser(963), Marauder(900), Black Ops(898), Tactical Destroyer(1305),
// Interceptor(831), Covert Ops(830), Stealth Bomber(834), Dreadnought(485),
// Carrier(547), Supercarrier(659), Titan(30), Lancer Dreadnought(4594),
// Flag Cruiser(1972), etc.

export function classifyShipRole(groupId: number): ShipRole {
  if (NON_COMBAT_GROUPS.has(groupId)) return 'non-combat';
  if (SUPPORT_GROUPS.has(groupId))    return 'support';
  if (LOGISTICS_GROUPS.has(groupId))  return 'logistics';
  if (COMMAND_GROUPS.has(groupId))    return 'command';
  if (TACKLE_GROUPS.has(groupId))     return 'tackle';
  if (EWAR_GROUPS.has(groupId))       return 'ewar';
  // Default: treat as combat (prefer false positives over false negatives for efficiency)
  return 'combat';
}

/** Returns true for roles that are expected to deal damage. */
export function isCombatRole(role: ShipRole): boolean {
  return role === 'combat';
}

/** Returns true for roles that are expected to deal damage. */
export function isDpsExpected(role: ShipRole): boolean {
  return role === 'combat';
}

/** Returns true for non-combat roles (support infrastructure, not damage dealers). */
export function isNonCombat(role: ShipRole): boolean {
  return role === 'support' || role === 'non-combat';
}
