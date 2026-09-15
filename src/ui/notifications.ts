// Notifications for incoming messages, honoring push rules via the SDK's
// client-side evaluation (getPushActionsForEvent).
//
// Platform reality (Android): everything here runs inside the WebView, so this
// in-app notifier only fires while the OS keeps the process + webview running
// (app foreground or recently backgrounded). True *background* delivery (app
// killed) is handled separately by the UnifiedPush layer — a native receiver
// registered as a Matrix pusher (see ui/push.ts, core/push.ts, and
// packaging/android/push/*.kt). When a push arrives with the app alive, that
// layer nudges sync so this notifier posts the rich, decrypted notification;
// when the app is dead it posts a plain "new message" itself.

import { ClientEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { SyncState } from "matrix-js-sdk";
import { getPrefs, resolveSound } from "./prefs";
import { playSound } from "./sounds";
import { channelFor, ensureAccountChannel, isAndroid, isTauri, loadTauriNotification } from "./notifyChannels";
import {
  createGroupingState,
  reduceIncoming,
  reduceRoomViewed,
  type PrivacyMode,
} from "./notifyGrouping";
import type { MaterixPushNative } from "./push";

let requested = false;

// Session-scoped tally for Android grouped notifications. The Kotlin notifier
// is stateless (see notifyGrouping.ts / MaterixPush.kt); JS owns the running
// "since last viewed" counts and sends the full desired state on every post.
const groupingState = createGroupingState();

/** The native bridge if present (Android build with apply-android-push.sh).
 * We only need the grouped-notification methods here; they are optional on
 * older bridge builds, so callers feature-detect before use. */
function nativeNotifier(): MaterixPushNative | null {
  const n = (window as unknown as { MaterixPushNative?: MaterixPushNative }).MaterixPushNative;
  return n ?? null;
}

/**
 * A room became visible (opened/read): zero its Android notification tally and
 * clear/repost the account summary. No-op off Android or without the native
 * grouped-notification bridge. Wired from App.tsx's selection effect.
 */
export function onRoomViewed(accountKey: string, roomId: string): void {
  if (!isAndroid) return;
  const bridge = nativeNotifier();
  if (!bridge?.clearRoom) return;
  const { clear } = reduceRoomViewed(groupingState, accountKey, roomId);
  if (!clear) return;
  // The summary (if it needs re-posting) goes through the per-account channel,
  // which was already ensured when notifications were wired.
  void ensureAccountChannel(accountKey, clear.accountLabel).then((channelId) => {
    try {
      bridge.clearRoom?.(JSON.stringify({ ...clear, ...(channelId ? { channelId } : {}) }));
    } catch (e) {
      console.warn("materix: clearing grouped notification failed", e);
    }
  });
}

async function ensureWebPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  if (requested) return false;
  requested = true;
  return (await Notification.requestPermission()) === "granted";
}

async function ensureTauriPermission(): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission } = await loadTauriNotification();
    if (await isPermissionGranted()) return true;
    if (requested) return false;
    requested = true;
    return (await requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function ensurePermission(): Promise<boolean> {
  return isTauri ? ensureTauriPermission() : ensureWebPermission();
}

/** Wire notification dispatch for one client. Returns an unsubscribe. */
export function wireNotifications(
  client: MatrixClient,
  accountKey: string,
  onActivate: (roomId: string) => void,
  isMuted: (roomId: string) => boolean,
  isRoomOpen: (roomId: string) => boolean,
): () => void {
  let ready = false;
  const onSync = (state: SyncState) => {
    // Skip everything from the initial sync; only notify for live events.
    if (state === SyncState.Syncing || state === SyncState.Prepared) ready = true;
  };
  const onEvent = async (ev: MatrixEvent, room: Room | undefined) => {
    const mode = getPrefs().notifications;
    if (mode === "off") return;
    if (!ready || !room) return;
    if (ev.getSender() === client.getUserId()) return;

    // Don't notify while the user is actively looking at the app — except on
    // Android, where the webview reports focus whenever the app is visible
    // (and can keep reporting stale focus after backgrounding), which used to
    // suppress every notification on the platform. There, only suppress when
    // the event's room is the one open on screen right now.
    const appActive = document.visibilityState === "visible" && document.hasFocus();
    if (isAndroid ? appActive && isRoomOpen(room.roomId) : appActive) return;

    const ts = ev.getTs();
    if (Date.now() - ts > 60_000) return; // stale/backfill
    if (isMuted(room.roomId)) return;
    const actions = client.getPushActionsForEvent(ev);
    if (!actions?.notify) return;

    const soundId = resolveSound(accountKey, room.roomId);
    // On desktop/web the in-app sound plays even if OS notification permission
    // is denied. On Android the notification's channel plays the (per-channel,
    // user-configurable) system tone, so the Web Audio sound is only a
    // fallback when no OS notification gets posted.
    if (!isAndroid) playSound(soundId);

    if (!(await ensurePermission())) {
      if (isAndroid) playSound(soundId);
      return;
    }

    // Privacy mode "name": never include content, only who wrote.
    let body = "New message";
    if (mode === "preview" && !ev.isBeingDecrypted() && !ev.isDecryptionFailure()) {
      const content = ev.getContent();
      body = typeof content.body === "string" ? content.body.slice(0, 140) : "New message";
    }
    const sender = room.getMember(ev.getSender() ?? "")?.name ?? ev.getSender() ?? "";
    const title = room.name === sender ? sender : `${sender} · ${room.name}`;

    if (isTauri) {
      // Android with the native grouped-notification bridge: route through our
      // Kotlin notifier so messages bundle per account with a running count and
      // re-alert every time (the plugin hardcodes setOnlyAlertOnce(true) and
      // drops setNumber). Feature-detected; falls back to the plugin below when
      // the bridge is absent (dev/sideload) or throws.
      if (isAndroid) {
        const bridge = nativeNotifier();
        if (bridge?.notifyMessage) {
          try {
            const channelId = await channelFor(
              accountKey,
              client.getUserId() ?? accountKey,
              room.roomId,
              room.name,
            );
            const { payload } = reduceIncoming(groupingState, {
              accountKey,
              accountLabel: client.getUserId() ?? accountKey,
              roomId: room.roomId,
              roomName: room.name,
              sender,
              body,
              title,
              mode: mode as PrivacyMode,
              channelId,
            });
            bridge.notifyMessage(JSON.stringify(payload));
            return;
          } catch (e) {
            // Bridge threw — fall through to the plugin path unchanged.
            console.warn("materix: native grouped notification failed; falling back", e);
          }
        }
      }
      try {
        const { sendNotification } = await loadTauriNotification();
        // Android: post through the per-room/per-account channel so the right
        // sound plays; elsewhere channelFor resolves to undefined.
        const channelId = await channelFor(
          accountKey,
          client.getUserId() ?? accountKey,
          room.roomId,
          room.name,
        );
        // roomId travels in `extra` so the click listener can focus the room.
        sendNotification({
          title,
          body,
          group: room.roomId,
          extra: { roomId: room.roomId },
          ...(channelId ? { channelId } : {}),
        });
      } catch (e) {
        // Plugin unavailable or IPC failed; fall back to the in-app sound.
        console.warn("materix: sending OS notification failed", e);
        if (isAndroid) playSound(soundId);
      }
      return;
    }

    try {
      const n = new Notification(title, { body, tag: `${room.roomId}` });
      n.onclick = () => {
        window.focus();
        onActivate(room.roomId);
        n.close();
      };
    } catch {
      // Web Notification unsupported; ignore.
    }
  };

  // On desktop, route a clicked/actioned notification back to its room. Click
  // activation is best-effort: the plugin surfaces it on platforms that report
  // it, and no-ops elsewhere. Registration is async, so hold a handle to
  // unregister on teardown.
  let actionListener: { unregister: () => void } | null = null;
  let disposed = false;
  if (isTauri) {
    loadTauriNotification()
      .then(({ onAction }) =>
        onAction((notification) => {
          const roomId = (notification.extra as { roomId?: string } | undefined)?.roomId;
          if (roomId) onActivate(roomId);
        }),
      )
      .then((listener) => {
        if (disposed) listener.unregister();
        else actionListener = listener;
      })
      .catch(() => {
        // onAction not supported on this platform; notifications still show.
      });
  }

  client.on(ClientEvent.Sync, onSync);
  client.on(RoomEvent.Timeline, onEvent as never);
  return () => {
    disposed = true;
    actionListener?.unregister();
    client.off(ClientEvent.Sync, onSync);
    client.off(RoomEvent.Timeline, onEvent as never);
  };
}
