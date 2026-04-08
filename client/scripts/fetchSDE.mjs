/**
 * scripts/fetchSDE.mjs
 *
 * Pre-build script: downloads the official EVE Online Static Data Export,
 * extracts groups.jsonl and types.jsonl, and generates:
 *
 *   client/src/lib/shipTypes.ts          — TypeScript ship-type map (EN names for log matching)
 *   client/src/locales/sde.<lang>.json   — Per-language i18next/Tolgee locale files
 *                                           containing { type: { "<typeId>": name },
 *                                                        group: { "<groupId>": name } }
 *
 * Supported SDE languages: en, de, fr, ja, ko, ru, zh
 *
 * Data source: https://developers.eveonline.com/static-data
 * Automation URL: https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip
 *
 * Usage: node scripts/fetchSDE.mjs
 */

import { writeFileSync, createWriteStream, existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import AdmZip from 'adm-zip';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SDE_ZIP_URL =
  'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip';

const OUT_SHIP_TYPES   = resolve(__dirname, '../src/lib/shipTypes.ts');
const OUT_WEAPON_TYPES = resolve(__dirname, '../src/lib/weaponTypes.ts');
const OUT_LOCALES    = resolve(__dirname, '../src/sde');
const TMP_ZIP        = resolve(__dirname, '../../.sde-tmp.zip');

// Ship category ID in EVE SDE
// Category IDs in EVE SDE
const CATEGORY_SHIP   = 6;
const CATEGORY_MODULE = 7;   // turrets, launchers, reppers, etc.
const CATEGORY_DRONE  = 18;  // combat/support drones
const CATEGORY_CHARGE = 8;   // ammo & missiles (appear as weapon in some log formats)
const WEAPON_CATEGORIES = new Set([CATEGORY_MODULE, CATEGORY_DRONE, CATEGORY_CHARGE]);
const SUPPORTED_LANGS = ['en', 'de', 'fr', 'ja', 'ko', 'ru', 'zh'];

async function downloadZip(url, dest) {
  console.log('[fetchSDE] Downloading SDE zip from', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading SDE`);

  const writer = createWriteStream(dest);
  const reader = Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    reader.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    reader.on('error', reject);
  });
  console.log('[fetchSDE] Download complete.');
}

/** Extract a localised name for every supported language from a SDE `name` value. */
function extractNames(nameField) {
  if (!nameField || typeof nameField !== 'object') {
    const fallback = typeof nameField === 'string' ? nameField : null;
    return Object.fromEntries(SUPPORTED_LANGS.map(l => [l, fallback]));
  }
  return Object.fromEntries(
    SUPPORTED_LANGS.map(l => [l, nameField[l] ?? nameField['en'] ?? null]),
  );
}

async function main() {
  try {
    await downloadZip(SDE_ZIP_URL, TMP_ZIP);

    console.log('[fetchSDE] Extracting groups.jsonl and types.jsonl...');
    const zip = new AdmZip(TMP_ZIP);

    // ─── Parse groups.jsonl ────────────────────────────────────────────────────
    const groupsEntry = zip.getEntry('groups.jsonl');
    if (!groupsEntry) throw new Error('groups.jsonl not found in SDE zip');

    /** groupId → categoryId */
    const groupCategoryMap = new Map();
    /** groupId → { lang: name } — only ship groups */
    const groupLangNames   = new Map();

    for (const line of groupsEntry.getData().toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let g;
      try { g = JSON.parse(line); } catch { continue; }
      const gId   = g._key ?? g.groupID;
      const catId = g.categoryID ?? g.category_id ?? null;
      if (gId == null || catId == null) continue;
      groupCategoryMap.set(Number(gId), Number(catId));
      if (Number(catId) === CATEGORY_SHIP) {
        groupLangNames.set(Number(gId), extractNames(g.name));
      }
    }
    console.log(
      `[fetchSDE] Loaded ${groupCategoryMap.size} group→category mappings, ` +
      `${groupLangNames.size} ship group names.`,
    );

    // ─── Parse types.jsonl ─────────────────────────────────────────────────────
    const entry = zip.getEntry('types.jsonl');
    if (!entry) throw new Error('types.jsonl not found in SDE zip');

    const jsonlContent = entry.getData().toString('utf8');
    const lines = jsonlContent.split('\n').filter((l) => l.trim());
    console.log(`[fetchSDE] Parsing ${lines.length} type records...`);

    /** typeId → { id, groupId, names: {lang: name} } */
    const shipTypeMap   = new Map();
    const weaponTypeMap = new Map();

    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }

      const typeId    = record._key ?? record.typeID;
      const groupId   = record.groupID ?? record.group_id ?? null;
      const published = record.published ?? true;
      const catId     = groupId != null ? groupCategoryMap.get(Number(groupId)) ?? null : null;
      if (!typeId || !groupId || !published) continue;

      const names = extractNames(record.name);
      if (!names.en) continue; // must have English name (used as log key)

      if (catId === CATEGORY_SHIP) {
        shipTypeMap.set(Number(typeId), { id: Number(typeId), groupId: Number(groupId), names });
      } else if (WEAPON_CATEGORIES.has(catId)) {
        weaponTypeMap.set(Number(typeId), { id: Number(typeId), names });
      }
    }
    console.log(`[fetchSDE] Found ${shipTypeMap.size} published ship types.`);
  console.log(`[fetchSDE] Found ${weaponTypeMap.size} published weapon types.`);

    const usedGroupIds = new Set([...shipTypeMap.values()].map(s => s.groupId));

    // ─── Emit shipTypes.ts ────────────────────────────────────────────────────
    const bodyLines = [...shipTypeMap.entries()]
      .map(([id, { groupId, names }]) => {
        const safeName = names.en.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `  [${id}, { id: ${id}, name: '${safeName}', groupId: ${groupId} }],`;
      })
      .join('\n');

    const groupNameLines = [...groupLangNames.entries()]
      .filter(([gid]) => usedGroupIds.has(gid))
      .sort(([a], [b]) => a - b)
      .map(([gid, names]) => {
        const safeName = (names.en ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `  [${gid}, '${safeName}'],`;
      })
      .join('\n');

    const shipTypesContent = `/**
 * shipTypes.ts — AUTO-GENERATED by scripts/fetchSDE.mjs
 * Source: EVE Online Static Data Export (developers.eveonline.com/static-data)
 * Do not edit by hand.
 */

export interface ShipType {
  id:      number;
  name:    string;   // English canonical name (as it appears in combat logs)
  groupId: number;
}

// @generated
const SHIP_TYPES_DATA: [number, ShipType][] = [
${bodyLines}
];

export const shipTypes: ReadonlyMap<number, ShipType> = new Map(SHIP_TYPES_DATA);

/** Group (ship class) names in English, keyed by groupId, e.g. 25 → 'Frigate'. */
export const GROUP_NAMES: ReadonlyMap<number, string> = new Map<number, string>([
${groupNameLines}
]);

/** Ships keyed by English type name for fast lookup from log entries. */
export const shipTypesByName: ReadonlyMap<string, ShipType> = new Map(
  SHIP_TYPES_DATA.map(([, st]) => [st.name, st]),
);

/** Return the English ship class / group name for a type name from a log entry. */
export function getShipCategory(typeName: string): string {
  const st = shipTypesByName.get(typeName);
  return st ? (GROUP_NAMES.get(st.groupId) ?? '') : '';
}
`;

    writeFileSync(OUT_SHIP_TYPES, shipTypesContent, 'utf8');
    console.log(`[fetchSDE] Wrote ${OUT_SHIP_TYPES}`);

    // ─── Emit weaponTypes.ts ──────────────────────────────────────────────────
    const weaponBodyLines = [...weaponTypeMap.entries()]
      .map(([id, { names }]) => {
        const safeName = names.en.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `  [${id}, { id: ${id}, name: '${safeName}' }],`;
      })
      .join('\n');

    const weaponTypesContent = `/**
 * weaponTypes.ts — AUTO-GENERATED by scripts/fetchSDE.mjs
 * Source: EVE Online Static Data Export (developers.eveonline.com/static-data)
 * Do not edit by hand.
 */

export interface WeaponType {
  id:   number;
  name: string;  // English canonical name (as it appears in combat logs)
}

// @generated
const WEAPON_TYPES_DATA: [number, WeaponType][] = [
${weaponBodyLines}
];

export const weaponTypes: ReadonlyMap<number, WeaponType> = new Map(WEAPON_TYPES_DATA);

/** Weapons keyed by English type name for fast lookup from log entries. */
export const weaponTypesByName: ReadonlyMap<string, WeaponType> = new Map(
  WEAPON_TYPES_DATA.map(([, wt]) => [wt.name, wt]),
);
`;

    writeFileSync(OUT_WEAPON_TYPES, weaponTypesContent, 'utf8');
    console.log(`[fetchSDE] Wrote ${OUT_WEAPON_TYPES}`);

    // ─── Emit per-language i18next locale files ────────────────────────────────
    mkdirSync(OUT_LOCALES, { recursive: true });

    for (const lang of SUPPORTED_LANGS) {
      const typeEntries = {};
      for (const [id, { names }] of shipTypeMap) {
        const name = names[lang] ?? names.en;
        if (name) typeEntries[String(id)] = name;
      }
      for (const [id, { names }] of weaponTypeMap) {
        const name = names[lang] ?? names.en;
        if (name) typeEntries[String(id)] = name;
      }
      const groupEntries = {};
      for (const [gid, names] of groupLangNames) {
        if (!usedGroupIds.has(gid)) continue;
        const name = names[lang] ?? names.en;
        if (name) groupEntries[String(gid)] = name;
      }

      const localeData = { type: typeEntries, group: groupEntries };
      const outPath = resolve(OUT_LOCALES, `sde.${lang}.json`);
      writeFileSync(outPath, JSON.stringify(localeData, null, 2), 'utf8');
      console.log(
        `[fetchSDE]   sde.${lang}.json — ` +
        `${Object.keys(typeEntries).length} types, ${Object.keys(groupEntries).length} groups`,
      );
    }

    console.log('[fetchSDE] Done.');
  } finally {
    if (existsSync(TMP_ZIP)) unlinkSync(TMP_ZIP);
  }
}

main().catch((err) => {
  console.error('[fetchSDE] Fatal error:', err);
  process.exit(1);
});
