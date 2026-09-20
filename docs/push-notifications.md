# Background notifications on Google-less Android (UnifiedPush + ntfy)

Materix runs entirely inside a system WebView. That means the normal in-app
notifier only works while the app's process is alive (foreground or recently
backgrounded); once Android freezes or kills it, sync stops and nothing can
notify you. On phones **with** Google Play this is solved by Firebase Cloud
Messaging (FCM). De-Googled ROMs (LineageOS, GrapheneOS, /e/OS, CalyxOS, …)
have no FCM, so Materix uses **[UnifiedPush](https://unifiedpush.org)** instead.

UnifiedPush is an open push standard. You run one small **distributor** app on
your phone (the easiest is **[ntfy](https://ntfy.sh)**) that keeps a single
battery-friendly connection to a push server. Every UnifiedPush-capable app —
Materix, your fediverse client, etc. — shares that one connection.

```
  new message
      │
  homeserver ──POST /_matrix/push/v1/notify──▶  ntfy  (Matrix push gateway)
                                                  │ publishes to your topic
                                                  ▼
                            ntfy app (UnifiedPush distributor on your phone)
                                                  │ UnifiedPush broadcast
                                                  ▼
                              Materix  ──sync + decrypt──▶  notification
```

ntfy conveniently plays **two** roles here: it's the push server your
distributor app connects to, *and* it exposes a built-in **Matrix Push
Gateway** at `/_matrix/push/v1/notify`, so no separate gateway (Sygnal) is
needed.

> **Privacy.** Materix registers the pusher with `format: "event_id_only"`, so
> the only thing that ever travels through the push server is *"event X in room
> Y happened"* — never sender, room name, or message text. Materix fetches and
> decrypts the actual message **on your device** after being woken. If you
> self-host ntfy, even that metadata stays on your own server.

---

## Quick start (using the public ntfy.sh — zero setup)

1. Install **ntfy** — from
   [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/) or the
   [Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy).
   Open it once so it registers as a UnifiedPush distributor. You don't need to
   create any topics or an account.
2. Open **Materix → Settings → Notifications → Background delivery
   (UnifiedPush)** and tap **Turn on**. Allow the notification permission when
   asked.
3. That's it. Materix picks up the endpoint ntfy hands it, derives the gateway
   (`https://ntfy.sh/_matrix/push/v1/notify`) automatically, and registers a
   Matrix pusher on each of your accounts. Send yourself a message from another
   device to confirm.

If you have more than one distributor installed, Materix asks you which one to
use.

---

## Self-hosting ntfy (recommended for privacy)

Self-hosting keeps all push metadata on infrastructure you control. You need a
server reachable from **both** your phone *and* your Matrix homeserver (so it
needs a public URL / domain, ideally with HTTPS).

### Run the server

Binary (single Go executable):

```bash
# https://docs.ntfy.sh/install/
ntfy serve --config /etc/ntfy/server.yml
```

Docker:

```bash
docker run -d --name ntfy -p 80:80 \
  -v /var/lib/ntfy:/var/lib/ntfy \
  -v /etc/ntfy:/etc/ntfy \
  binwiederhier/ntfy serve
```

Minimal `server.yml` — the Matrix gateway turns on automatically as soon as
`base-url` is set:

```yaml
base-url: "https://ntfy.example.org"     # must be publicly reachable
listen-http: ":80"                        # put a TLS reverse proxy in front
cache-file: "/var/lib/ntfy/cache.db"
cache-duration: "12h"
auth-file: "/var/lib/ntfy/auth.db"
auth-default-access: "read-write"         # or lock down with tokens/ACLs
```

Verify the Matrix gateway is live (should answer `{"rejected":[]}` for a
reachable topic pushkey):

```bash
curl -s -X POST https://ntfy.example.org/_matrix/push/v1/notify \
  -H 'Content-Type: application/json' \
  -d '{"notification":{"devices":[{"app_id":"org.materix.app.unifiedpush",
       "pushkey":"https://ntfy.example.org/UPtest?up=1"}]}}'
```

### Point your phone + Materix at it

1. In the **ntfy app → Settings → General → Default server**, set
   `https://ntfy.example.org`. (Re-registering apps will then get endpoints on
   your server.)
2. In **Materix → Settings → Notifications → Background delivery**, tap
   **Turn on**. Because Materix derives the gateway from the endpoint's origin,
   pointing the ntfy app at your server is all it takes — no gateway URL to
   type.

> **Advanced — split gateway.** If your Matrix push gateway lives on a
> *different* host than the topic server (e.g. a standalone Sygnal with
> UnifiedPush support), expand **Advanced: push gateway** in the same settings
> panel and enter its `…/_matrix/push/v1/notify` URL. Leave it blank in the
> normal ntfy case.

---

## How it works in Materix (for maintainers)

| Piece | Location |
|-------|----------|
| Matrix pusher registration (`event_id_only`, gateway derivation) | `src/core/push.ts` |
| Native→JS orchestration (endpoint → pusher, push → sync/notify) | `src/ui/push.ts` |
| Settings UI | `src/ui/dialogs/SettingsDialog.tsx` (`PushSettings`) |
| Native UnifiedPush receiver + WebView bridge | `packaging/android/push/*.kt` |
| CI injection into the (regenerated) Android project | `scripts/apply-android-push.sh`, wired in `.github/workflows/android.yml` |

The native `MaterixUnifiedPushReceiver` receives the push even when Materix's
process is dead. If the WebView is alive it forwards the payload to
matrix-js-sdk, which syncs the referenced event and posts the rich, decrypted
notification through the normal notifier. If the process is dead it can't
decrypt, so it posts a plain *"new message"* to wake you — opening Materix then
syncs and shows the message.

The `app_id` is `org.materix.app.unifiedpush`; the pusher's `pushkey` is the
UnifiedPush endpoint URL, and `data.url` is the ntfy Matrix gateway.

---

## Grouping & counts

Materix bundles Android message notifications **per account** with a running
count, instead of one system notification per message.

### Why this needs native code

The stock `@tauri-apps/plugin-notification` can't produce correct messenger
grouping on Android:

- it hardcodes `setOnlyAlertOnce(true)`, so every message after the first would
  be **silent** on a stable/updated notification, and
- it never applies `number`, so there's **no count badge**.

So the live path posts through the native layer we already own
(`packaging/android/push/MaterixPush.kt`, injected by
`scripts/apply-android-push.sh`) via the `window.MaterixPushNative` bridge.
Desktop (plugin) and web (`new Notification` with a per-room `tag`) are
unchanged.

### Live path (app alive) — the grouped notifier

Element-style: **one group per account**, one **child** notification per room,
and one **group summary** per account.

- The Kotlin side is **stateless** — it just renders. JS
  (`src/ui/notifications.ts`, with the pure reducer in
  `src/ui/notifyGrouping.ts`) owns a per-account / per-room tally of messages
  notified **since the room was last viewed**, and sends the *complete* desired
  state (`notifyMessage`) on every post:

  ```jsonc
  {
    "accountKey":   "…",          // group key = "acct.<accountKey>"
    "accountLabel": "@me:hs",     // summary title / subtext
    "roomId":       "!room:hs",   // child id = stableId("room.<acct>.<roomId>")
    "channelId":    "acct.…",     // per-room override or per-account channel
    "title":        "alice · #room",
    "body":         "latest text",
    "roomLines":    ["alice: hi", "alice: there"],  // ≤5, child InboxStyle
    "roomCount":    2,            // child number badge
    "accountLines": ["alice: hi", "alice: there"],  // ≤7, summary InboxStyle
    "totalCount":   2             // summary number badge + "N new messages"
  }
  ```

- Children re-alert on every message (`setOnlyAlertOnce(false)`); the summary
  updates silently (`setOnlyAlertOnce(true)`). Sound/importance still come from
  the per-account (`acct.<key>`) or per-room (`room.<key>.<roomId>`) channel, so
  per-room sound overrides keep working.
- **Clearing:** opening a room zeroes its tally and sends `clearRoom`
  (`{ accountKey, roomId, remainingTotal, accountLines, channelId }`): the child
  is cancelled and the summary is either re-posted with the remainder or
  cancelled when the account hits zero.
- **Tap:** a child carries `materix.roomId` / `materix.accountKey` extras;
  `MainActivity.onNewIntent` (patched in by the apply script) forwards them as a
  `materix-notif-open` event and `src/ui/push.ts` deep-links into the room.
- **Privacy** is honored exactly as the legacy notifier: in "name" mode the
  lines are the sender only (no message content ever reaches a line); in
  "preview" mode they are `sender: body`. No decrypted content is persisted
  anywhere — the tally lives only in memory.
- Feature-detected: if the native bridge is absent (dev build / sideload without
  the apply script) or throws, JS falls back to the plain plugin
  `sendNotification` unchanged.

### Dead-process path (app killed) — running count

The `event_id_only` push carries no content and no account attribution (all
accounts share one UnifiedPush endpoint), so this path stays a single
**standalone** notification on stable id `1` that each push replaces. It is now
upgraded to show the homeserver's **`counts.unread`** total as "N new messages"
with a count badge, when the (spec-optional) field is present — otherwise it
falls back to the plain "New message". It is not grouped (the account is
unknown here) and is cleared when the app opens (`attach()` cancels id 1); the
live sync then posts the rich grouped block.

---

## Troubleshooting

- **"Turn on" is greyed out** → no UnifiedPush distributor is installed. Install
  ntfy and open it once.
- **Enabled but never notified** →
  - Make sure the ntfy app itself can reach its server (open it; it shows the
    connection state). On self-host, confirm the phone can load
    `https://your-server/`.
  - Confirm the pusher registered: on any Element client, *Settings → Notifications*
    lists active pushers, or check `GET /_matrix/client/v3/pushers`. You should
    see one with `app_id: org.materix.app.unifiedpush`.
  - Self-host only: your **homeserver** must be able to POST to the gateway. If
    the homeserver can't reach `base-url`, pushes silently never arrive.
  - Battery optimisation can kill the distributor — exclude the ntfy app from
    battery optimisation.
- **Notifications say only "new message"** → that's the dead-process fallback;
  tap it and Materix syncs the full, decrypted message. (Content is never sent
  through the push server by design.)
- **Turn it off** → *Background delivery → Turn off* removes the Matrix pushers
  from every account and unregisters from the distributor.

---

## Keep connected in background (foreground service)

UnifiedPush wakes Materix *after* the OS has already killed it, so the reopened
app still cold-starts (and matrix-js-sdk re-decrypts the restored timeline
in-memory — see the "re-decrypt on cold launch" issue). If you'd rather Materix
simply **stay resident**, enable *Notifications → Keep connected in background*.

This starts an opt-in **foreground service** (`MaterixSyncService`) that holds
the whole process — WebView and live Matrix sync — at foreground-service
priority so Android's low-memory killer leaves it alone. Because it keeps the
already-decrypted state warm, reopening is instant and there's no re-decrypt.

- Android requires a permanent low-priority "Staying connected in the
  background" notification while the service runs — that's expected.
- Enabling it also offers the **battery-optimization exemption**
  (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) so the OS schedules the app's network
  more aggressively while idle. It deliberately does **not** hold a wakelock, so
  it won't fight Doze.
- It's independent of UnifiedPush: you can run either, both, or neither. Both is
  the most reliable (resident sync + a push to wake it if the OS ever wins).
- Trade-off: a resident process uses more battery than push-only delivery. Leave
  it off if you prefer minimal battery use and are fine with a cold reopen.
