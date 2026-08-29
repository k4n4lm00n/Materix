# Timeline & composer fixes (mobile polish round)

Five fixes shipped together on `feat/nav-mode-parity`, verified with
`tsc --noEmit`, `vite build`, and live headless-browser runs against a local
Synapse fixture (see `.agents/nav-parity/verify-fixes.mjs`).

> **Round 2 (below, "Mobile polish round 2") deliberately changes two of these
> behaviors**: Logout no longer lives in the avatar quick-menu (§2) and Edit is
> only offered for server-acknowledged messages (§5's fast-edit-of-a-pending-
> echo path is now unreachable from the UI; the `RoomHandle.edit()` resolver
> remains as defense in depth).

## 1. Action bar opens on long-press, not on scroll taps

The message action bar (quick reactions, reply, edit, …) used to toggle on any
touch *click* landing on a bubble — a scroll or swipe that ended near a bubble
fired that click, so the bar popped up while scrolling.

`src/ui/Timeline.tsx` now runs a pointer-based long-press detector on each
message row: `pointerdown` (non-mouse, on the bubble, not on a link) starts a
470 ms timer, cancelled by movement past a 9 px slop (a scroll) or an early
`pointerup`/`pointercancel` (a tap). Only a completed hold toggles the bar.
The synthetic click that follows a long-press is swallowed so it doesn't
immediately toggle the bar back off, and the `contextmenu` event Android
synthesizes from a long-press is suppressed for touch pointers (touch uses the
action bar; real right-clicks still open the desktop context menu). A plain
tap never opens the bar but does dismiss an open one. Desktop
hover-to-reveal and right-click behavior are unchanged.

## 2. Logout in the header avatar menu

The avatar dropdown (Manage account / Add account / Show-Hide accounts bar /
Settings) gained a final, red **Logout** item that signs out the *active*
account via the same `accountManager.logout` path as Settings → Accounts →
Sign out (confirmation included). The Settings → Accounts sign-out button was
deliberately kept: it is the canonical per-account management surface and the
only way to sign out a *non-active* account in multi-account setups.

## 3. Composer bottom margin on first keyboard open (Android)

On Android the keyboard inset reached the page (via the MainActivity
IME-inset listener, see `.github/workflows/android.yml`), but the composer's
bottom offset was only correct after some later reflow (e.g. the textarea
auto-growing) — the initial keyboard-open read of the viewport metrics could
be stale, because the WebView updates `window.innerHeight` and
`visualViewport.height` at slightly different moments than it dispatches the
resize events.

`src/ui/viewport.ts` now:

- sizes `--app-h` from the *smallest credible* height
  (`min(visualViewport.height, innerHeight)`) so whichever metric updated
  first wins during a keyboard open;
- re-applies the measurement on a settle schedule (rAF + 100/250/500/1000 ms)
  after every resize/orientation/`focusin`/`focusout` trigger, so late metric
  updates (including the keyboard-close direction, where the stale value is
  the *small* one) converge without needing a reflow;
- re-scrolls the focused field whenever the usable height actually changes
  (previously only on raw resize events).

Verified on desktop-shaped viewports that `--app-h` still tracks the
viewport; **the actual first-open IME margin needs on-device confirmation**
(no emulator available in this environment — the reasoning is from the inset
pipeline above).

## 4. Copy actions work in the Android WebView

`navigator.clipboard` is undefined/blocked in the Android WebView, so "Copy
text" (and every other copy action) silently did nothing. New shared helper
`src/ui/clipboard.ts` `copyText()` tries, in order:

1. the Tauri `clipboard-manager` plugin — now wired: Cargo dependency +
   `tauri_plugin_clipboard_manager::init()` in `src-tauri/src/lib.rs`,
   `clipboard-manager:allow-write-text` in `src-tauri/capabilities/default.json`,
   and the `@tauri-apps/plugin-clipboard-manager` guest package;
2. `navigator.clipboard.writeText`;
3. a hidden `<textarea>` + `document.execCommand("copy")`.

It rejects only if all three fail, so success/error toasts are truthful.
Routed through it: message "Copy text" (`Timeline.tsx`), "Copy user ID"
(`userMenu.ts`), "Copy room address" (`RoomList.tsx`), and the recovery-key
Copy button (`SecurityDialog.tsx`).

## 5. Editing a message no longer errors (and a failed edit stays an edit)

Two stacked bugs:

- **Root cause of the error**: an edit target captured from the timeline can
  be a still-sending local echo whose id is `~<roomId>:<txnId>`. Sending an
  `m.replace` relation to a `~` id makes matrix-js-sdk call
  `Room.getPendingEvents()`, which **throws** under the default
  `pendingEventOrdering: chronological` ("Cannot call getPendingEvents…").
  Encrypted rooms keep the pending window long enough to hit this routinely.
  `RoomHandle.edit()` now resolves the target first (`resolveEventId`):
  a stale `~` id is re-resolved via the transaction id embedded in it (the id
  is swapped in place once the remote echo arrives), polling up to 10 s for
  the echo; a clear, retriable `MaterixError` is raised if the original never
  finishes sending. Send errors are wrapped with `toMaterixError` like every
  other send path (previously the raw error surfaced as "Something went
  wrong.").
- **Root cause of the duplicate**: `Composer.send()` cleared the edit/reply
  mode *before* awaiting the send, so after a failure the restored text was
  re-sent through the plain-send path as a brand-new message. The mode is now
  cleared only after the send succeeds; a failure keeps the edit target and
  the corrected text so Send retries the *edit*. The edit branch also no
  longer falls through to a plain send when the event id is missing.

Verified live: a fast edit of a just-sent message in an encrypted room lands
as an edit; with the `/send/` endpoint failure-injected, the edit errors,
stays in edit mode with the corrected text, and the retry (after unblocking)
replaces the original message — rendered "(edited)", no duplicate.

---

# Mobile polish round 2

Five follow-up fixes on the same branch, verified with `tsc --noEmit`,
`vite build`, vitest, and a live headless-browser suite against the local
Synapse fixture (37 checks, `.agents/nav-parity/verify-round2.mjs`).

## R2.1 No one-tap Logout in the header bar

There never was a literal Logout button in the bar — what users saw was the
avatar quick-menu (with its red Logout item) lingering over the bar because of
the dismiss race fixed in R2.2. With that fixed, the direct **Logout item was
removed from the avatar quick-menu** anyway: one stray tap away from the bar
is too accident-prone. Sign-out stays reachable via **Manage account**
(→ Settings → Accounts, per-account "Sign out" with a confirm dialog) and via
Settings directly. Net effect: no stray tap on the bar can ever sign the user
out.

## R2.2 Context menus: real toggle + consumed outside-press

`ContextMenu` used a window-level `mousedown` listener to close on
outside-click. Two failures:

- clicking the avatar while its menu was open closed the menu on `mousedown`
  and re-opened it on the button's `click` — the classic close-then-reopen
  race, so the avatar never toggled;
- the outside click *fell through* to the UI underneath (selected a room,
  toggled a view).

The listener is replaced with a **full-viewport backdrop element**
(`.ctx-backdrop`) under the menu. An outside press of any pointer type lands
on the backdrop, which closes the menu and consumes the press
(`preventDefault` + `stopPropagation` on `pointerdown`, so it covers touch as
well as mouse); a one-shot capture-phase listener swallows the trailing
`click` that the browser retargets after the backdrop unmounts (disarmed by
the next fresh `pointerdown` or after 600 ms). Because the opener button sits
*under* the backdrop, every opener is now automatically a toggle: the second
press only closes. Escape-to-close, keyboard navigation and close-on-selection
are unchanged, and all `ContextMenu` users (avatar menu, "+" new-chat menu,
message right-click menu, room context menu, user menus) inherit the fix.

## R2.3 Android system Back never closes the app

System Back used to finish the activity (wry's default: WebView
`history.back`, else `finish()`). Now:

- **Native** (`scripts/apply-android-push.sh`, step 5 — the gen/android tree
  is regenerated in CI, so it is patched not committed): MainActivity sets
  `override val handleBackNavigation = false` (disables wry's built-in Back
  callback) and registers an always-enabled `OnBackPressedCallback` that
  forwards every press into the page:
  `webView.evaluateJavascript("window.dispatchEvent(new Event('android-back'))")`.
  The activity is never finished; the only way to close Materix is the app
  switcher.
- **JS** (`src/ui/androidBack.ts`, wired in `App.tsx`): the `android-back`
  event walks a priority ladder — close the top overlay first (context menu /
  emoji picker → Escape; lightbox → click; top-most modal → synthetic
  backdrop-mousedown), else close the room-details panel, else leave the open
  chat back to the room list on the narrow layout, else **no-op**.

The ladder is fully browser-tested by dispatching `android-back`; the native
half needs the on-device stage (patched MainActivity output was verified by
running the script's patch stages against a pristine generated
MainActivity.kt, including composition with the CI insets patch and
idempotency/stale-tree guards).

## R2.4 Long-press vs. scroll, made robust

The round-1 detector still mis-fired in busy rooms. Root causes and fixes:

- **The real bug**: on the narrow (`max-width: 760px`, i.e. phone) layout,
  `.app` flips to a flex *column* and `.chat-pane` had no `min-height: 0`, so
  a long timeline blew the pane up to content height and the **document**
  scrolled while `.timeline` itself never did. Scroll-position logic
  (stick-to-bottom, top-edge pagination) silently no-opped and no scroll ever
  hit the container. Fixed with `min-height: 0` on `.chat-pane`.
- `touch-action: pan-y` on `.timeline` and `.msg-row`: the browser owns
  vertical panning and fires `pointercancel` the moment a scroll gesture
  starts, which cancels the pending press.
- Scroll-cancel: a **capture-phase `document` scroll listener attached per
  press** (scroll events don't bubble, but capture sees every scroll target —
  the timeline, the document, or whatever container exists after a reflow, so
  it cannot go stale across re-renders/reopens). Any scroll while the 470 ms
  timer is pending cancels the press: if the list moved at all, it's a
  scroll.
- Slop check is now per-axis (> 8 px on either axis cancels; was a 9 px
  radius), only the primary touch pointer arms the timer, and a second finger
  landing while a press is pending cancels it (pinch/two-finger scroll).
- Unchanged: a completed hold toggles the bar and swallows the trailing
  synthetic click; a plain tap never opens the bar but dismisses an open one.

## R2.5 Edit only for server-acknowledged messages

Editing a message the server hadn't finished processing raced the original
send. The Edit affordance (hover/long-press action bar **and** the right-click
menu, `Timeline.tsx`) is now only offered when the event is server-acked:
a real `$…` event id (not a `~roomId:txnId` local-echo placeholder) and
`sendState` neither `"sending"` nor `"failed"` (i.e. absent for fully synced
events or `"sent"` for just-acked ones — see `RoomHandle.toItem`). Threads
reuse `TimelineRow`, so thread replies inherit the gate. The round-1
`RoomHandle.edit()` echo-resolver and the composer retry fix remain as a
second line of defense for anything that still targets a pending event.

## Verification

`.agents/nav-parity/verify-round2.mjs` (local Synapse + headless Chromium,
desktop + touch contexts) — all 37 checks pass: no logout in bar/menu;
avatar toggle open→close with no reopen race (mouse and touch); outside
press closes without selecting the room underneath; "+" menu, room context
menu, message menu all still work and close on selection; `android-back`
ladder (menu → modal → details → narrow chat → no-op); touch drag and a
mid-press scroll never open the action bar while a stationary long-press
does (in a >100-row room); Edit hidden for a pending echo and appearing on
ack.

Left for the on-device stage: real hardware Back (native callback), IME
interplay, and scroll-feel with the action-bar long-press on a physical
screen.
