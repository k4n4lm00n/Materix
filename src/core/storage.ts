// Session persistence facade (contract: Auth section).
// Web: localStorage. Desktop (Tauri): OS keychain via IPC, so access tokens
// never sit in webview localStorage.

import type { SessionData } from "./types";

const PREFIX = "materix.account.";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// Generic small-secret storage (OS keychain on desktop, localStorage on web).
// Used for the crypto-store key record; caller owns the full key name.
export async function secretSet(key: string, value: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke("secret_set", { key, value });
      return;
    } catch (e) {
      console.warn("Keychain unavailable, using localStorage", e);
    }
  }
  localStorage.setItem(key, value);
}

export async function secretGet(key: string): Promise<string | null> {
  if (isTauri()) {
    try {
      const v = await tauriInvoke<string | null>("secret_get", { key });
      if (v != null) return v;
    } catch (e) {
      console.warn("Keychain unavailable, reading localStorage", e);
    }
  }
  return localStorage.getItem(key);
}

export async function saveSession(key: string, data: SessionData): Promise<void> {
  const value = JSON.stringify(data);
  if (isTauri()) {
    try {
      await tauriInvoke("secret_set", { key: PREFIX + key, value });
      return;
    } catch (e) {
      console.warn("Keychain unavailable, falling back to localStorage", e);
    }
  }
  localStorage.setItem(PREFIX + key, value);
}

export async function loadSessions(): Promise<Map<string, SessionData>> {
  const out = new Map<string, SessionData>();
  if (isTauri()) {
    try {
      const keys = await tauriInvoke<string[]>("secret_list_keys");
      for (const k of keys) {
        if (!k.startsWith(PREFIX)) continue;
        const v = await tauriInvoke<string | null>("secret_get", { key: k });
        if (v) out.set(k.slice(PREFIX.length), JSON.parse(v) as SessionData);
      }
    } catch (e) {
      console.warn("Keychain unavailable, reading localStorage", e);
    }
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (!k.startsWith(PREFIX)) continue;
    const short = k.slice(PREFIX.length);
    if (out.has(short)) continue;
    try {
      out.set(short, JSON.parse(localStorage.getItem(k)!) as SessionData);
    } catch {
      // DATA-SAFETY: do NOT delete the record on a parse failure. A transient
      // half-written value (e.g. a WebView killed mid-write) would otherwise
      // permanently sign the user out. Skip it for this launch only.
      console.warn(`Skipping unreadable session record ${k}`);
    }
  }
  return out;
}

export async function deleteSession(key: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriInvoke("secret_delete", { key: PREFIX + key });
    } catch {
      // fall through to localStorage cleanup either way
    }
  }
  localStorage.removeItem(PREFIX + key);
}

/** Stable local account identifier per contract: sha256(userId|deviceId)[0..16]. */
export async function accountKeyFor(userId: string, deviceId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${userId}|${deviceId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
