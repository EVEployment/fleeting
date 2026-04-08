import { describe, it, expect } from 'vitest';
import { parseLine, parseHeader } from '@/lib/logRegex';

const CHAR_NAME = 'TestPilot';

// Real EVE log line samples (from mockCombatLogs.mjs format)
const DPS_OUT_LINE =
  '[ 2024.03.15 12:34:56 ] (combat) <color=0xff00ffff><b>742</b><color=0x77ffffff><font size=10>to</font> <color=0xffffffff><b>Opionia Tek[AIR (Devoter)]</b><color=0xFFFFFFFF><b> -</b> <color=0x77ffffff><font size=10> - Mega Pulse Laser II - Hits</font>';

const DPS_IN_LINE =
  '[ 2024.03.15 12:34:57 ] (combat) <color=0xff00ffff><b>385</b><color=0x77ffffff><font size=10>from</font> <color=0xffffffff><b>boernl[FALG (Stiletto)]</b><color=0xFFFFFFFF><b> -</b> <color=0x77ffffff><font size=10> - Heavy Missile Launcher II - Penetrates</font>';

const MINING_LINE =
  '[ 2024.03.15 12:35:00 ] (mining) <color=0xfff2cc0c><b>1200</b>';

const HINT_LINE =
  '[ 2024.03.15 12:35:01 ] (hint) Attempting to join a channel';

describe('parseLine', () => {
  it('parses dpsOut line correctly', () => {
    const entry = parseLine(DPS_OUT_LINE, CHAR_NAME, 'english');
    expect(entry).not.toBeNull();
    expect(entry!.category).toBe('dpsOut');
    expect(entry!.amount).toBe(742);
    expect(entry!.pilotName).toBe(CHAR_NAME);
    expect(entry!.targetName).toContain('Opionia Tek');
    expect(entry!.weaponType).toContain('Mega Pulse Laser II');
    expect(entry!.hitQuality).toBe('Hits');
    expect(entry!.logOwner).toBe(CHAR_NAME);
  });

  it('parses dpsIn line correctly', () => {
    const entry = parseLine(DPS_IN_LINE, CHAR_NAME, 'english');
    expect(entry).not.toBeNull();
    expect(entry!.category).toBe('dpsIn');
    expect(entry!.amount).toBe(385);
    expect(entry!.targetName).toBe(CHAR_NAME);
    expect(entry!.pilotName).toContain('boernl');
    expect(entry!.weaponType).toContain('Heavy Missile Launcher II');
    expect(entry!.hitQuality).toBe('Penetrates');
  });

  it('parses mining line correctly', () => {
    const entry = parseLine(MINING_LINE, CHAR_NAME, 'english');
    expect(entry).not.toBeNull();
    expect(entry!.category).toBe('mined');
    expect(entry!.amount).toBe(1200);
    expect(entry!.pilotName).toBe(CHAR_NAME);
    expect(entry!.hitQuality).toBeNull();
  });

  it('returns null for hint line', () => {
    const entry = parseLine(HINT_LINE, CHAR_NAME, 'english');
    expect(entry).toBeNull();
  });

  it('returns null for empty string', () => {
    const entry = parseLine('', CHAR_NAME, 'english');
    expect(entry).toBeNull();
  });

  it('returns null for notify/non-combat lines', () => {
    const notifyLine = '[ 2024.03.15 12:35:01 ] (notify) Some notification';
    const entry = parseLine(notifyLine, CHAR_NAME, 'english');
    expect(entry).toBeNull();
  });
});

describe('parseHeader', () => {
  it('extracts characterName from English log header', () => {
    const headerText = `------------------------------------------------------------\nGamelogs\nListener: MyCharacterName\nSession Started: 2024.03.15 12:00:00\n------------------------------------------------------------\n`;
    const result = parseHeader(headerText);
    expect(result).not.toBeNull();
    expect(result!.characterName).toBe('MyCharacterName');
    expect(result!.language).toBe('english');
  });

  it('returns null if no listener line found', () => {
    const result = parseHeader('No listener info here\nJust some text');
    expect(result).toBeNull();
  });
});
