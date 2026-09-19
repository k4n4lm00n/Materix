// A drop-in IndexedDBStore that makes the "never delete the store without an
// explicit user action" invariant ABSOLUTE.
//
// THE PROBLEM (verified in matrix-js-sdk/lib/store/indexeddb.js): every store
// accessor is wrapped in `degradable()`. On ANY IndexedDB error it emits
// "degraded" and then, in the very next line, awaits `backend.clearDatabase()`
// — which calls `indexedDB.deleteDatabase(dbName)`, wiping the whole on-disk
// store ("it's only a cache"), before degrading to an in-memory store. Because
// the delete runs *after* the "degraded" event, a plain event listener cannot
// prevent it (the delete is already queued). The old WebViews that break the
// crypto WASM in the first place are exactly the ones prone to IndexedDB
// errors, so this auto-delete is a live data-loss path even on the
// crypto-success path.
//
// THE FIX: intercept the backend's `clearDatabase` and turn the auto-delete
// into a non-destructive degrade — log it and keep the on-disk DB intact. The
// SDK still degrades to MemoryStore for the current session (correct: the store
// is a cache and re-syncs on next healthy launch), it just no longer destroys
// the persisted data. This is scoped to OUR store instances only — we never
// globally monkey-patch `indexedDB.deleteDatabase`. Explicit deletion
// (account.destroy(), storeMaintenance) uses `indexedDB.deleteDatabase`
// directly and is unaffected.

import { IndexedDBStore } from "matrix-js-sdk";

interface ProtectableBackend {
  clearDatabase?: () => Promise<unknown>;
  dbName?: string;
  __materixProtected?: boolean;
}

export class NonDestructiveIndexedDBStore extends IndexedDBStore {
  constructor(opts: ConstructorParameters<typeof IndexedDBStore>[0]) {
    super(opts);
    this.protectBackend();
  }

  /** Neutralize the backend's auto-delete-on-degrade. Idempotent; safe to call
   *  again if the SDK swaps the backend (e.g. worker-factory fallback). */
  private protectBackend(): void {
    // `backend` is a public getter on IndexedDBStore returning the live backend.
    const backend = (this as unknown as { backend?: ProtectableBackend }).backend;
    if (!backend || backend.__materixProtected || typeof backend.clearDatabase !== "function") return;
    const dbName = backend.dbName;
    backend.clearDatabase = () => {
      // DATA-SAFETY: do NOT delete the on-disk database. Degrade-to-memory only.
      console.warn(
        `[data-safety] Suppressed matrix-js-sdk auto-delete of IndexedDB store "${dbName}" ` +
          `after a degrade; on-disk data preserved (session continues in-memory).`,
      );
      return Promise.resolve();
    };
    backend.__materixProtected = true;
  }
}
