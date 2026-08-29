# Persistent decrypted-event cache (issue #4)

## The problem

Materix is a **matrix-js-sdk** app (crypto via `matrix-sdk-crypto-wasm`). On a
cold launch it correctly restores from IndexedDB:

- the sync state (no re-`/sync` — logcat: *"not doing HTTP hit, instead
  returning stored /sync data"*), and
- the Olm account + inbound group sessions / keys (logcat: *"Restored an Olm
  account"*) — **keys are not re-fetched.**

What it does **not** persist is the **decrypted plaintext**. In matrix-js-sdk a
decrypted event's clear content lives only in the in-memory
`MatrixEvent.clearEvent`; the sync store writes only ciphertext. So every cold
launch rehydrates events from ciphertext and re-runs megolm decryption
in-memory. The cost scales with timeline size — wasted CPU/battery every time
the app is reopened (which the background-kill issue, #3, makes frequent).

Element (Android) avoids this because **matrix-rust-sdk** ships a persistent
*event cache* that stores decrypted timelines on disk.

## Approach

A Materix-side persistent cache of decrypted plaintext, keyed by event id, in
its own IndexedDB database (`materix-decrypted-<account>`), so we can render
plaintext immediately on relaunch instead of paying for re-decryption. This is a
pragmatic local layer; the strategic fix is matrix-rust-sdk's event cache (worth
flagging upstream against matrix-js-sdk).

## Status

**Implemented (this scaffold — `src/core/decryptedCache.ts`, wired in
`src/core/account.ts`):**

- `DecryptedCache` — an IndexedDB store of `{eventId, roomId, type, content, v,
  cachedAt}`, versioned (`CACHE_VERSION`, wholesale-dropped on format change),
  soft-capped (`MAX_ROWS`) with oldest-first pruning. Every op is best-effort:
  a cache fault can never break messaging, only forgo the optimization.
- **Record** on `MatrixEventEvent.Decrypted` — persists plaintext only when the
  event actually decrypted (encrypted, not a failure, not in-flight, not
  redacted).
- **Evict** on `RoomEvent.Redaction` — drops the redacted target so redacted
  content is never resurrected from cache.
- **Privacy** — the cache DB is closed on `stop()` and **deleted on
  `destroy()`** (sign-out), so cached plaintext never outlives the session.

**Read fast-path — wired (`src/core/roomHandle.ts`, `src/core/account.ts`):**

The cache is now read on render, so a cold launch shows cached plaintext
immediately instead of the "waiting for this message" placeholder while js-sdk
re-decrypts in the background.

1. **Warm in-memory layer.** `DecryptedCache.get` is async but the timeline
   snapshot builders are synchronous, so `RoomHandle` keeps a warm
   `Map<eventId, CachedClear>`. On `timeline()` / `threadItems()`,
   `warmFromCache()` batch-loads persisted plaintext for the room's
   still-encrypted events off the render path (each id read at most once), then
   calls back into the account to bump the room's render version
   (`events.emit("room:…")`) so the synchronous builders re-run and paint the
   hits. First paint is never blocked on IndexedDB.
2. **Cache only while the SDK hasn't decrypted.** `awaitingDecryption(ev)` is
   true while the event is encrypted and the SDK holds no clear content
   (decryption failure / in-flight / type still `m.room.encrypted`). In that
   window `toItem` builds the item from the cached `{type, content}` via
   `cachedItem()`; on a miss it falls through to `encrypted-pending`. The
   **SDK is the source of truth**: the moment js-sdk fires
   `MatrixEventEvent.Decrypted`, `awaitingDecryption` turns false, the cache
   branch is skipped, and the write side re-records. Plaintext is **never**
   injected back into the SDK (`MatrixEvent.clearEvent` has no supported
   setter) — this is a Materix-side display accelerator only.
3. **Invalidation.** `m.replace` edits evict the target's cached row (both the
   persistent row and the handle's warm copy) — caught cleartext in
   `RoomEvent.Timeline` before the edit itself decrypts, and again on
   `Decrypted`. Redaction evict and sign-out (`destroy`) DB deletion are kept.
4. Every cache op stays best-effort: an absent cache disables the fast-path and
   a fault only forgoes the optimization; messaging is never affected.

## Open questions

- **Scope/measurement.** On a tiny (2-room) test account the cold-start decrypt
  is sub-second — no visible storm. Measure on a large account before investing
  in the read path; the win is proportional to timeline size.
- **Correctness surface.** The cache must never diverge from the SDK's view
  (edits, redactions, key changes, un-decryptable→decryptable transitions). The
  version field + evict hooks are the guardrails; the read path must treat the
  SDK as source of truth and the cache as a pure display accelerator.
- **Upstream.** Long-term this belongs in the SDK (matrix-rust-sdk-style event
  cache). Track whether to push js-sdk upstream vs. carry the Materix layer.
