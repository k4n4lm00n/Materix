# Nav mode parity: Chats/Rooms toggles, unread badges, collapsible accounts bar

## Problem

The left-column navigation rendered a *different* control set depending on
orientation (`max-width: 760px`):

| Control | Landscape (wide) | Portrait (narrow) — before |
| --- | --- | --- |
| Account avatar / rail | visible | **hidden** with a single account (`.rail:not(.multi) { display: none }`) |
| Add account / Settings (rail) | visible | **hidden** with a single account |
| Chats/Rooms sections | **none** (plain `<h1>Chats</h1>`) | text tabs, mutually exclusive |
| Settings (list header) | **none** | visible |

So the avatar existed only in landscape (and clicking it was a no-op for the
active/only account), while the Chats/Rooms split existed only in portrait.
Rotating the device made buttons appear and disappear.

## Requirements

1. **Mode parity (critical).** Every nav button is present and functional in
   both portrait and landscape. A control's *presence* is never gated on
   orientation — only sizing/layout may adapt.
2. **Chats/Rooms as icon toggles.** Chats = talk bubble (`IconChat`), Rooms =
   hash glyph (`IconHash`, new). They are *independent* show/hide filters
   (`showChats` / `showRooms`, both default on), not mutually exclusive tabs.
   Classification is unchanged: Chats = `isDirect`, Rooms = everything else.
   Each toggle exposes `aria-pressed` plus a title/aria-label.
3. **Per-toggle unread badges.** The Chats icon shows the unread total of
   direct rooms, the Rooms icon of non-direct rooms — each computed like the
   rail badge (`unreadCount` + 1 per pending invite), clamped at "99+".
4. **Useful avatar.** The account avatar is visible in both modes; clicking
   the *active* (or only) account opens Settings instead of no-op
   re-activation. Clicking another account still switches to it.

## After

Both orientations render the same controls:

- **Room-list header** (always present) — active-account avatar first, then
  the Chats toggle (bubble icon + unread badge) and Rooms toggle (hash icon +
  unread badge); on the opposite end explore globe, new-chat "+", Join, and a
  Settings gear. The wide-only `<h1>Chats</h1>` heading is gone.
- **Accounts bar** (`AccountRail`, collapsible — see below) — hide button
  first, then avatar(s) with total-unread badge, add-account "+", Settings
  gear. Vertical at the left in landscape; horizontal strip at the top in
  portrait (the `.rail:not(.multi)` hiding rule is gone). Active avatar
  click → Settings; other avatar click → switch account.

## Single vs. multiple accounts: the accounts bar

The always-on rail gave a single-account user **two** bars for no benefit, so
the accounts bar is now driven by one shared `showAccountsBar` state (hoisted
into `App`, persisted as `prefs.ui.accountsBar`):

- **Default (pref unset):** shown iff more than one account is signed in.
  One account → a single bar (the room-list header); several accounts → the
  accounts bar appears on startup.
- **Explicit toggles** write the pref, so the choice sticks across restarts
  (a multi-account user can keep it hidden; a single-account user can pin it).

Where it's toggled from:

- The **header avatar** opens a dropdown (`ContextMenu`) with exactly:
  1. *Manage account* — opens Settings scrolled to its **Accounts** section
     (profile, sounds, passcode, devices, sign-out — the app's account
     management surface; `SettingsDialog` gained `initialSection`).
  2. *Add account* — the existing add-account onboarding modal.
  3. *Show/Hide accounts bar* — flips `showAccountsBar` (label reflects the
     current state).
  4. *Settings* — same dialog as the gear (deliberate duplicate so it's one
     tap from the avatar too).
- The rail itself has a **hide button** (chevrons, before the accounts) that
  sets `showAccountsBar = false`; the avatar-menu item brings it back.

All of these — avatar menu, Chats/Rooms toggles, explore, New, Join,
Settings, and the rail hide button — exist in **both** orientations; nothing
is gated on `narrow`. With the rail hidden in portrait the room-list header
is the topmost strip and takes over the status-bar safe-area inset.

Toggle semantics: both on (default) shows everything; hiding one filters out
that half of the list; hiding both shows an "Everything is hidden" empty
state. Invitations remain visible regardless of filters (existing behavior),
and the invite/archived/low-priority grouping is unchanged.

## Implementation notes

- `src/ui/RoomList.tsx` — `section: "chats" | "rooms"` state replaced by
  `showChats`/`showRooms` booleans; header rendered unconditionally (no
  `narrow` media-query gating left in this component); per-section unread
  reducers mirror the rail's; empty-state branches keyed off the toggles.
  Header gained the avatar menu button, Join, and Settings; `AccountRail`
  gained the hide button.
- `src/App.tsx` — hoists `showAccountsBar` (pref override ?? multi-account
  default), renders the rail conditionally, threads the menu handlers.
- `src/ui/prefs.ts` — `ui?: { accountsBar?: boolean }`.
- `src/ui/dialogs/SettingsDialog.tsx` — optional `initialSection: "accounts"`
  scrolls the Accounts section into view ("Manage account" target).
- `src/ui/components/Icons.tsx` — added `IconHash`, `IconEnter` (join),
  `IconCollapse` (hide bar).
- `src/ui/app.css` — `.section-tab` restyled as an icon toggle with a
  `.section-badge` (mirrors `.rail-badge`); removed the portrait
  `.rail:not(.multi){display:none}` rule; portrait keeps its larger touch
  targets (40px) via the existing media query; `.header-avatar-btn`; the
  header inherits the safe-area top inset when it's the first pane.

Follow-up: the avatar menu later gained a fifth, visually separated (red)
**Logout** item for the active account — see `docs/timeline-composer-fixes.md`
and "Round 3" below (removed in round 2, reinstated in round 3 as the *only*
logout surface outside Settings).

## Round 3: logout placement, Back backgrounds, room-header Back, bar chevrons

Four device-feedback fixes on top of the above (all verified on a real
Chromium-141 phone and the Chromium-83 compat emulator):

1. **Logout lives in the avatar menu — never as a bar icon.** The avatar
   dropdown regains a final red **Logout** item (confirm dialog →
   `accountManager.logout(activeKey)`); Settings → Accounts keeps its
   canonical Sign out. The standalone **Join a room** header button
   (`IconEnter`) was removed: its door-and-arrow glyph reads as a *logout*
   icon at bar size. Joining stays one tap away inside the "+" menu.
2. **Top-level Back backgrounds the app (Element-style).** The
   `androidBack.ts` ladder's step 4 is no longer a no-op: when nothing is
   left to close (room list on screen), it calls the native bridge's new
   `moveTaskToBack()` (`MaterixPush.kt`, `@JavascriptInterface`,
   `activity.moveTaskToBack(true)` on the UI thread). The task retreats to
   the home screen but the activity, process and warm WebView survive, so
   the next launcher tap resumes instantly — no cold frontend reload, and
   still never `finish()`. (A Rust/JNI Tauri command was considered, but
   tao 0.35 no longer initializes `ndk-context`, so the injected Kotlin
   bridge — already attached by `apply-android-push.sh` in every Android
   build — is the reliable path.)
3. **Element-style room header with an always-on Back.** `ChatPane`'s header
   back button lost its `narrow`-only gating (the `showBackButton` prop is
   gone): back arrow + room avatar + name + actions in every layout and
   orientation. The on-screen arrow and hardware Back both return
   chat → room list; only *at the list* does hardware Back background the
   app.
4. **Accounts-bar chevron that moves between bars.** Bar hidden → a **»**
   (`IconChevronRight`, new) sits *before* the avatar in the room-list
   header and shows the bar. Bar shown → the rail's leading hide button is a
   **«** (`IconChevronLeft`, new; replaces the `IconCollapse` double
   chevron) and the header » disappears. Exactly one chevron is visible at
   a time, always pointing where the bar will go; the avatar-menu
   "Show/Hide accounts bar" item remains as the labelled alternative.

Verified with `tsc --noEmit`, `vite build`, and live headless-browser runs
against a local Synapse fixture (alice + bob; DM and group room with unread
messages), in both 412×915 and 915×412: single account renders exactly one
bar with the full control set and a working 4-item avatar menu; the pref
default flips to shown after adding a second account; the rail hide button /
menu item toggle and persist across reloads; badges and independent
Chats/Rooms filtering unchanged.
