// Persistent decrypted-event cache — SCAFFOLD for k4n4lm00n/Materix#4.
//
// Problem: matrix-js-sdk keeps a decrypted event's plaintext only in the
// in-memory `MatrixEvent.clearEvent`; the sync store persists only ciphertext.
// So every cold launch rehydrates events from ciphertext and re-runs megolm
// decryption in-memory — CPU/battery that scales with timeline size. Element
// avoids this because matrix-rust-sdk ships a persistent decrypted event cache.
//
// This module persists the decrypted {type, content} of each event to its own
// IndexedDB database, keyed by event id, so a future render fast-path can show
// plaintext immediately instead of waiting on (and paying for) re-decryption.
//
// STATUS: the write side (record/evict/read/prune) implemented here is complete
// and correct. The READ fast-path — feeding cached plaintext into the render
// layer (see roomHandle.ts) so the re-decrypt is actually skipped — is the
// remaining work and is intentionally NOT wired yet. See docs/decrypted-cache.md.

import type { MatrixEvent } from "matrix-js-sdk";

/** Bump when the stored shape changes; a mismatch drops the old DB wholesale. */
const CACHE_VERSION = 1;

/** Soft cap on rows; the oldest (by cachedAt) are pruned past this. */
const MAX_ROWS = 50_000;

const STORE = "events";

export interface CachedClear {
  eventId: string;
  roomId: string;
  /** The decrypted event type (e.g. `m.room.message`). */
  type: string;
  /** The decrypted event content. */
  content: Record<string, unknown>;
  /** Cache-format version the row was written with. */
  v: number;
  /** Epoch ms the row was cached — used for LRU-ish pruning. */
  cachedAt: number;
}

/**
 * One cache per account (crypto/keys are per-account). Best-effort throughout:
 * every operation swallows errors so a cache fault can never break messaging —
 * the worst case is falling back to normal re-decryption.
 */
export class DecryptedCache {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  /** Debounced prune guard so we don't count rows on every put. */
  private putsSincePrune = 0;

  constructor(accountKey: string) {
    this.dbName = `materix-decrypted-${accountKey}`;
  }

  /** Open (or create) the backing store. Safe to call more than once. */
  async open(): Promise<void> {
    if (this.db) return;
    this.db = await this.openDb();
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = window.indexedDB.open(this.dbName, CACHE_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        // On any version change, start clean — cached plaintext is disposable.
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        const os = db.createObjectStore(STORE, { keyPath: "eventId" });
        os.createIndex("cachedAt", "cachedAt");
        os.createIndex("roomId", "roomId");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Record an event's decrypted plaintext. No-op unless the event actually
   * decrypted (encrypted, not a decryption failure, not still in flight, not
   * redacted). Fire-and-forget.
   */
  record(event: MatrixEvent): void {
    const db = this.db;
    if (!db) return;
    if (!event.isEncrypted()) return; // clear events don't need caching
    if (event.isDecryptionFailure() || event.isBeingDecrypted() || event.isRedacted()) return;
    const eventId = event.getId();
    const roomId = event.getRoomId();
    if (!eventId || !roomId) return;

    const row: CachedClear = {
      eventId,
      roomId,
      type: event.getType(),
      content: event.getContent() as Record<string, unknown>,
      v: CACHE_VERSION,
      cachedAt: Date.now(),
    };
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
    } catch {
      return;
    }
    if (++this.putsSincePrune >= 1000) {
      this.putsSincePrune = 0;
      void this.prune();
    }
  }

  /** Drop a cached row — call on redaction / edit / failed re-decrypt. */
  evict(eventId: string): void {
    const db = this.db;
    if (!db) return;
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(eventId);
    } catch {
      // ignore
    }
  }

  /** Read a cached row, or undefined on miss / stale version / error. */
  get(eventId: string): Promise<CachedClear | undefined> {
    const db = this.db;
    if (!db) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(eventId);
        req.onsuccess = () => {
          const row = req.result as CachedClear | undefined;
          resolve(row && row.v === CACHE_VERSION ? row : undefined);
        };
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  /** Trim the store back toward MAX_ROWS, oldest first. Best-effort. */
  private prune(): Promise<void> {
    const db = this.db;
    if (!db) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const os = tx.objectStore(STORE);
        const countReq = os.count();
        countReq.onsuccess = () => {
          let over = countReq.result - MAX_ROWS;
          if (over <= 0) {
            resolve();
            return;
          }
          const cursorReq = os.index("cachedAt").openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor || over <= 0) {
              resolve();
              return;
            }
            cursor.delete();
            over--;
            cursor.continue();
          };
          cursorReq.onerror = () => resolve();
        };
        countReq.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = null;
  }
}
