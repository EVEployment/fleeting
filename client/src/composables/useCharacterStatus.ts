/**
 * useCharacterStatus — app-level singleton composable
 *
 * Periodically checks every character's online status (and fleet-boss status
 * for FC users) via ESI, and auto-establishes a fleet session when a character
 * is detected as Fleet Boss with no existing session.
 *
 * Module-level state is intentionally shared across all component instances so
 * that the polling loop runs once regardless of how many components call this
 * composable.
 */

import { reactive } from 'vue';
import { api } from '@/api/client';
import type { MeResponse } from '@/api/client';

/** Poll interval: 60 s — matches the ESI online-status cache window. */
const POLL_INTERVAL_MS = 60_000;

export interface CharStatus {
  /** null = not yet checked */
  online: boolean | null;
  /** true when the character holds the fleet_commander role in EVE */
  isFleetBoss: boolean;
  eveFleetId: string | null;
  session: { id: string; name: string } | null;
}

interface CharFleetResponse {
  online: boolean;
  role: string | null;
  eveFleetId: string | null;
  session: { id: string; name: string } | null;
}

/** Reactive map of characterId → CharStatus, shared across all consumers. */
export const charStatus = reactive<Record<number, CharStatus>>({});

let _timer: ReturnType<typeof setInterval> | null = null;
let _me: MeResponse | null = null;
/** Characters for which an auto-create is currently in flight. */
const _creating = new Set<number>();

async function pollFcCharacter(me: MeResponse, charId: number): Promise<void> {
  try {
    const data = await api.get<CharFleetResponse>(`/api/character/${charId}/fleet`);
    charStatus[charId] = {
      online:      data.online,
      isFleetBoss: data.role === 'fleet_commander',
      eveFleetId:  data.eveFleetId,
      session:     data.session,
    };

    // Auto-establish a fleet session when the character is Fleet Boss and no
    // open session exists yet.
    if (
      data.online &&
      data.role === 'fleet_commander' &&
      data.eveFleetId &&
      !data.session &&
      !_creating.has(charId)
    ) {
      _creating.add(charId);
      try {
        const charName = me.characters.find((c) => c.id === charId)?.name ?? String(charId);
        const fleet = await api.post<{ id: string; name: string }>('/api/fleet', {
          name:         `${charName}'s Fleet`,
          fcCharacterId: charId,
          eveFleetId:   data.eveFleetId,
        });
        if (charStatus[charId]) {
          charStatus[charId] = { ...charStatus[charId], session: { id: fleet.id, name: fleet.name } };
        }
      } catch {
        // Auto-create failed — will retry on the next poll cycle.
      } finally {
        _creating.delete(charId);
      }
    }
  } catch {
    // Do not reset state on transient errors to avoid UI flicker.
  }
}

async function pollOnlineCharacter(charId: number): Promise<void> {
  try {
    const data = await api.get<{ online: boolean }>(`/api/character/${charId}/online`);
    if (charStatus[charId]) {
      charStatus[charId] = { ...charStatus[charId], online: data.online };
    } else {
      charStatus[charId] = { online: data.online, isFleetBoss: false, eveFleetId: null, session: null };
    }
  } catch {
    // Silently ignore — keeps the last known state.
  }
}

async function pollAll(): Promise<void> {
  if (!_me) return;
  const isFc = isFleetCommanderUser(_me);
  await Promise.all(
    _me.characters.map((c) =>
      isFc ? pollFcCharacter(_me!, c.id) : pollOnlineCharacter(c.id),
    ),
  );
}

function isFleetCommanderUser(me: MeResponse): boolean {
  return me.roles.some((r) => r === 'fc' || r === 'war_commander');
}

export function useCharacterStatus() {
  /**
   * Start (or update) the polling loop for the given user.
   * Safe to call multiple times — deduplicates internally.
   */
  function start(me: MeResponse): void {
    _me = me;
    // Ensure initial state entries exist for all characters.
    for (const char of me.characters) {
      if (!(char.id in charStatus)) {
        charStatus[char.id] = { online: null, isFleetBoss: false, eveFleetId: null, session: null };
      }
    }
    if (_timer !== null) return; // Already polling; _me updated above is enough.
    pollAll().catch(console.error);
    _timer = setInterval(() => pollAll().catch(console.error), POLL_INTERVAL_MS);
  }

  /** Stop polling and clear state (call on logout). */
  function stop(): void {
    if (_timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
    _me = null;
  }

  /**
   * Trigger an immediate re-check for the specified character IDs
   * (defaults to all known characters).
   */
  function refresh(charIds?: number[]): void {
    if (!_me) return;
    const ids = charIds ?? _me.characters.map((c) => c.id);
    const isFc = isFleetCommanderUser(_me);
    for (const id of ids) {
      if (isFc) {
        pollFcCharacter(_me, id).catch(console.error);
      } else {
        pollOnlineCharacter(id).catch(console.error);
      }
    }
  }

  return { charStatus, start, stop, refresh };
}
