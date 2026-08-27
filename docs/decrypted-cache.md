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

**Not yet wired — the read fast-path (the part that actually skips
re-decryption):**

The write side is complete and correct, but nothing reads the cache yet, so
re-decryption is not yet avoided. The remaining work:

1. On cold start, before/while the render layer (`src/core/roomHandle.ts`) shows
   a timeline, look up each still-encrypted event via `DecryptedCache.get(id)`
   and render the cached `{type, content}` immediately, letting js-sdk decrypt
   lazily (or not at all) in the background.
2. Decide the integration seam. matrix-js-sdk exposes **no supported setter** for
   `MatrixEvent.clearEvent`, so we deliberately do **not** inject plaintext back
   into the SDK. The clean option is to have Materix's own render/preview path
   (`roomHandle.ts` `previewText`, timeline item builders) prefer the cache when
   an event `isBeingDecrypted()`/`isEncrypted()` and only fall through to the SDK
   on a miss.
3. Invalidate on edits (`m.replace` relations) in addition to redaction.

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
