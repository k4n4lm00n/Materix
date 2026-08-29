// Local UI preferences (per device, not synced).

import type { SoundId } from "./sounds";

export type NotificationMode = "preview" | "name" | "off";

interface Prefs {
  notifications: NotificationMode;
  /** Global default notification sound. */
  sound: SoundId;
  /** Per-account default sounds, keyed by account key. */
  accountSounds: Record<string, SoundId>;
  /** Per-room sound overrides, keyed by `${accountKey}:${roomId}`. */
  roomSounds: Record<string, SoundId>;
  /** Left-nav layout. */
  ui?: {
    /**
     * Accounts-bar visibility. Absent = never toggled explicitly; the app then
     * defaults to "shown iff more than one account is signed in".
     */
    accountsBar?: boolean;
  };
  /** Background push (UnifiedPush) — Android only; absent = never configured. */
  push?: {
    enabled: boolean;
    /** Chosen UnifiedPush distributor package id (e.g. `io.heckel.ntfy`). */
    distributorId?: string;
    /** Advanced: override the derived Matrix push-gateway URL. */
    gatewayOverride?: string;
    /**
     * Keep a foreground service running so Android doesn't reclaim the
     * backgrounded process (and its warm decrypted state). Android only.
     */
    keepAlive?: boolean;
  };
}

const KEY = "materix.prefs";
const DEFAULTS: Prefs = { notifications: "preview", sound: "ping", accountSounds: {}, roomSounds: {} };

let cached: Prefs | null = null;
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  if (!cached) {
    try {
      cached = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
    } catch {
      cached = { ...DEFAULTS };
    }
  }
  return cached;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  cached = { ...getPrefs(), [key]: value };
  localStorage.setItem(KEY, JSON.stringify(cached));
  listeners.forEach((l) => l());
}

export function onPrefsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function roomSoundKey(accountKey: string, roomId: string): string {
  return `${accountKey}:${roomId}`;
}

/** Most specific configured sound: room override → account default → global. */
export function resolveSound(accountKey: string, roomId: string): SoundId {
  const p = getPrefs();
  return p.roomSounds[roomSoundKey(accountKey, roomId)] ?? p.accountSounds[accountKey] ?? p.sound;
}

/** Set (or with undefined, clear) an account's default notification sound. */
export function setAccountSound(accountKey: string, sound: SoundId | undefined): void {
  const next = { ...getPrefs().accountSounds };
  if (sound === undefined) delete next[accountKey];
  else next[accountKey] = sound;
  setPref("accountSounds", next);
}

/** Set (or with undefined, clear) a room's notification-sound override. */
export function setRoomSound(accountKey: string, roomId: string, sound: SoundId | undefined): void {
  const next = { ...getPrefs().roomSounds };
  const k = roomSoundKey(accountKey, roomId);
  if (sound === undefined) delete next[k];
  else next[k] = sound;
  setPref("roomSounds", next);
}
