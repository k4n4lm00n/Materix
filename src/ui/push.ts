// Orchestrates background push on Android: bridges the native UnifiedPush layer
// (see packaging/android/push/*.kt) to the Matrix pusher registration in
// core/push.ts.
//
// Native → JS arrives as window CustomEvents dispatched by MaterixPush.kt:
//   materix-up-endpoint             (detail = endpoint URL)
//   materix-up-message              (detail = raw gateway payload JSON)
//   materix-up-registration-failed  (detail = instance)
//   materix-up-unregistered         (detail = instance)
// JS → native goes through the `window.MaterixPushNative` JavascriptInterface.
//
// Everything here no-ops off Android (the native bridge is absent), so desktop
// and web are unaffected.

import { accountManager } from "../core/manager";
import { registerUnifiedPushPusher, removeUnifiedPushPushers } from "../core/push";
import { getPrefs, setPref } from "./prefs";
import { isAndroid } from "./notifyChannels";

/** The native bridge, injected as `window.MaterixPushNative` by MaterixPush.kt. */
interface MaterixPushNative {
  ping(): boolean;
  /** JSON: [{ id: string, name: string }]. */
  getDistributors(): string;
  getSavedDistributor(): string;
  getAckDistributor(): string;
  saveDistributor(id: string): void;
  register(): void;
  unregister(): void;
  getEndpoint(): string;
  hasNotificationPermission(): boolean;
  requestNotificationPermission(): void;
  /** Top-level Back: background the task, activity kept alive (androidBack.ts). */
  moveTaskToBack(): void;
  // Foreground "keep sync alive" service (see MaterixSyncService.kt).
  isForegroundSyncSupported(): boolean;
  isForegroundSyncRunning(): boolean;
  startForegroundSync(): void;
  stopForegroundSync(): void;
  // Battery-optimization exemption.
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
}

function native(): MaterixPushNative | null {
  const n = (window as unknown as { MaterixPushNative?: MaterixPushNative }).MaterixPushNative;
  try {
    return n && n.ping() ? n : null;
  } catch {
    return null;
  }
}

export interface Distributor {
  id: string;
  name: string;
}

export interface PushStatus {
  /** Native bridge present (Android build) — push is offerable at all. */
  available: boolean;
  /** User has enabled background push. */
  enabled: boolean;
  /** Installed UnifiedPush distributor apps (e.g. ntfy). */
  distributors: Distributor[];
  /** The distributor we're registered with, if any. */
  savedDistributor: string | null;
  /** The current endpoint (topic URL), if the distributor has issued one. */
  endpoint: string | null;
  /** Whether Android will let us post notifications (POST_NOTIFICATIONS). */
  hasNotificationPermission: boolean;
  /** OS supports the foreground keep-alive service (API 26+). */
  foregroundSyncSupported: boolean;
  /** User has enabled the foreground keep-alive service. */
  keepAlive: boolean;
  /** The foreground keep-alive service is currently running. */
  foregroundSyncRunning: boolean;
  /** Materix is exempt from battery optimization. */
  ignoringBatteryOptimizations: boolean;
}

function deviceLabel(): string {
  // The homeserver's pusher/device list entry. Keep it human + stable.
  return "Materix · Android";
}

function distributors(n: MaterixPushNative): Distributor[] {
  try {
    return JSON.parse(n.getDistributors()) as Distributor[];
  } catch {
    return [];
  }
}

/** Register (or refresh) our pusher on every logged-in account for `endpoint`. */
async function registerPushersForAll(endpoint: string): Promise<void> {
  const gatewayUrl = getPrefs().push?.gatewayOverride?.trim() || undefined;
  await Promise.allSettled(
    accountManager.list().map((a) => {
      const client = accountManager.account(a.key).client;
      return client
        ? registerUnifiedPushPusher(client, { endpoint, gatewayUrl, deviceDisplayName: deviceLabel() })
        : Promise.resolve();
    }),
  );
}

/** Remove our pushers from every account (disable / no more push wanted). */
async function removePushersForAll(): Promise<void> {
  await Promise.allSettled(
    accountManager.list().map((a) => {
      const client = accountManager.account(a.key).client;
      return client ? removeUnifiedPushPushers(client) : Promise.resolve();
    }),
  );
}

let wired = false;

/** Attach the native→JS event listeners exactly once. */
function wireListeners(): void {
  if (wired) return;
  wired = true;

  window.addEventListener("materix-up-endpoint", (e) => {
    const endpoint = (e as CustomEvent<string>).detail;
    if (!endpoint || !getPrefs().push?.enabled) return;
    void registerPushersForAll(endpoint);
  });

  // App is alive when this fires — hasten each client's sync so the normal
  // in-app notifier (wireNotifications) posts the rich, decrypted notification.
  window.addEventListener("materix-up-message", () => {
    for (const a of accountManager.list()) {
      try {
        accountManager.account(a.key).client?.retryImmediately();
      } catch {
        // sync not running / client gone — ignore
      }
    }
  });

  window.addEventListener("materix-up-unregistered", () => {
    void removePushersForAll();
  });
}

/** Read the current push status (safe on any platform). */
export function pushStatus(): PushStatus {
  const n = native();
  if (!n) {
    return {
      available: false,
      enabled: false,
      distributors: [],
      savedDistributor: null,
      endpoint: null,
      hasNotificationPermission: false,
      foregroundSyncSupported: false,
      keepAlive: false,
      foregroundSyncRunning: false,
      ignoringBatteryOptimizations: false,
    };
  }
  const saved = n.getSavedDistributor();
  const ep = n.getEndpoint();
  return {
    available: true,
    enabled: !!getPrefs().push?.enabled,
    distributors: distributors(n),
    savedDistributor: saved || null,
    endpoint: ep || null,
    hasNotificationPermission: n.hasNotificationPermission(),
    foregroundSyncSupported: safeBool(() => n.isForegroundSyncSupported()),
    keepAlive: !!getPrefs().push?.keepAlive,
    foregroundSyncRunning: safeBool(() => n.isForegroundSyncRunning()),
    ignoringBatteryOptimizations: safeBool(() => n.isIgnoringBatteryOptimizations()),
  };
}

/** Call a native bool method that may be absent on an older bridge build. */
function safeBool(fn: () => boolean): boolean {
  try {
    return !!fn();
  } catch {
    return false;
  }
}

/**
 * Turn on the foreground "keep sync alive" service so Android stops reclaiming
 * the backgrounded process (and its warm, already-decrypted state). Also offers
 * the battery-optimization exemption. Persists the choice; no-op off Android.
 */
export async function enableForegroundSync(): Promise<PushStatus> {
  const n = native();
  if (!n) return pushStatus();
  // A foreground service needs POST_NOTIFICATIONS for its ongoing notification.
  n.requestNotificationPermission();
  setPref("push", { ...getPrefs().push, enabled: getPrefs().push?.enabled ?? false, keepAlive: true });
  try {
    n.startForegroundSync();
  } catch {
    // absent on an older bridge — pref is set; a rebuilt app will honor it
  }
  if (!safeBool(() => n.isIgnoringBatteryOptimizations())) {
    try {
      n.requestIgnoreBatteryOptimizations();
    } catch {
      // ignore — the service still helps without the exemption
    }
  }
  return pushStatus();
}

/** Turn off the foreground keep-alive service. Persists the choice. */
export async function disableForegroundSync(): Promise<PushStatus> {
  setPref("push", { ...getPrefs().push, enabled: getPrefs().push?.enabled ?? false, keepAlive: false });
  try {
    native()?.stopForegroundSync();
  } catch {
    // ignore
  }
  return pushStatus();
}

/**
 * Turn on background push. Picks the distributor (the given one, else the saved
 * one, else the only installed one) and registers. Returns the resulting
 * status; if several distributors are installed and none is chosen yet, push is
 * left disabled and the caller should prompt the user to pick from
 * `status.distributors`.
 */
export async function enablePush(distributorId?: string): Promise<PushStatus> {
  const n = native();
  if (!n) return pushStatus();
  n.requestNotificationPermission();

  const list = distributors(n);
  const chosen = distributorId || n.getSavedDistributor() || (list.length === 1 ? list[0].id : "");
  if (!chosen) {
    // Ambiguous — needs a user choice. Leave disabled; surface the options.
    return pushStatus();
  }

  n.saveDistributor(chosen);
  setPref("push", { ...getPrefs().push, enabled: true, distributorId: chosen });
  wireListeners();
  n.register(); // → materix-up-endpoint, which registers the pushers

  // If the distributor already issued an endpoint (re-enable), register now too.
  const ep = n.getEndpoint();
  if (ep) await registerPushersForAll(ep);
  return pushStatus();
}

/** Turn off background push: remove pushers and unregister from the distributor. */
export async function disablePush(): Promise<PushStatus> {
  setPref("push", { ...getPrefs().push, enabled: false });
  await removePushersForAll();
  native()?.unregister();
  return pushStatus();
}

/** Set an explicit gateway override (empty clears it) and re-register pushers. */
export async function setPushGatewayOverride(url: string): Promise<void> {
  setPref("push", {
    ...getPrefs().push,
    enabled: getPrefs().push?.enabled ?? false,
    gatewayOverride: url.trim() || undefined,
  });
  const ep = native()?.getEndpoint();
  if (ep && getPrefs().push?.enabled) await registerPushersForAll(ep);
}

/**
 * Initialise push at app startup and whenever the account set changes. On
 * Android with push enabled it re-asserts the distributor registration and
 * (re)registers the Matrix pusher for every account against the known endpoint.
 * No-op everywhere else.
 */
export function initPush(): void {
  if (!isAndroid) return;
  const n = native();
  if (!n) return;
  wireListeners();
  // Keep-alive is independent of UnifiedPush: re-assert it before the push
  // early-return so it survives cold starts / app updates.
  if (getPrefs().push?.keepAlive) {
    try {
      n.startForegroundSync();
    } catch {
      // absent on an older bridge — ignore
    }
  }
  if (!getPrefs().push?.enabled) return;
  // Re-assert registration (endpoints can rotate; the distributor re-emits one).
  n.register();
  const ep = n.getEndpoint();
  if (ep) void registerPushersForAll(ep);
}
