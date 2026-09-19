// Low-level IndexedDB primitives used by store maintenance (corruption
// detection, archive, delete). Factored into their own module so the
// orchestration in storeMaintenance.ts can be unit-tested with these mocked
// (there is no fake-indexeddb in the dependency set).
//
// DATA-SAFETY: every read here is strictly read-only and side-effect free — in
// particular the probes MUST NOT create a database that did not already exist
// (opening an absent DB would create it). deleteDatabase is only ever called by
// the explicit, user-initiated paths in storeMaintenance / account.destroy().

/** List existing IndexedDB database names, or null if the browser can't (old
 *  Firefox / no `databases()` support). Purely read-only. */
export async function listDatabaseNames(): Promise<string[] | null> {
  const idb = globalThis.indexedDB as (IDBFactory & { databases?: () => Promise<{ name?: string }[]> }) | undefined;
  if (!idb || typeof idb.databases !== "function") return null;
  try {
    const dbs = await idb.databases();
    return dbs.map((d) => d.name ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

export type SyncProbe = "missing" | "empty" | "hasData" | "error";

/**
 * Read-only probe of a matrix-js-sdk sync store: does it hold a real sync
 * token? Returns:
 *  - "missing": the DB does not exist (probe aborts creation, no side effect),
 *  - "empty":   exists but no `sync` store / no persisted next_batch (fresh),
 *  - "hasData": exists and has advanced its sync token (real synced data),
 *  - "error":   the DB could not be opened/read (half-written / corrupt).
 * Never writes, never creates, never deletes.
 */
export function probeSyncStore(dbName: string): Promise<SyncProbe> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve("missing");
  return new Promise<SyncProbe>((resolve) => {
    let created = false;
    // Open at the store's current version (no version arg) so we don't trigger
    // an upgrade on an existing DB. If `onupgradeneeded` fires the DB did NOT
    // exist — abort the transaction so it is never actually created.
    const req = idb.open(dbName);
    req.onupgradeneeded = (ev) => {
      created = true;
      try {
        (ev.target as IDBOpenDBRequest).transaction?.abort();
      } catch {
        /* ignore */
      }
    };
    req.onerror = () => resolve(created ? "missing" : "error");
    req.onblocked = () => resolve("error");
    req.onsuccess = () => {
      const db = req.result;
      if (created) {
        db.close();
        resolve("missing");
        return;
      }
      if (!db.objectStoreNames.contains("sync")) {
        db.close();
        resolve("empty");
        return;
      }
      try {
        const tx = db.transaction(["sync"], "readonly");
        const store = tx.objectStore("sync");
        const getReq = store.get(["-"]); // keyPath is ["clobber"], constant key "-"
        getReq.onsuccess = () => {
          const rec = getReq.result as { nextBatch?: string } | undefined;
          db.close();
          resolve(rec && rec.nextBatch ? "hasData" : "empty");
        };
        getReq.onerror = () => {
          db.close();
          resolve("error");
        };
      } catch {
        db.close();
        resolve("error");
      }
    };
  });
}

/** Delete an IndexedDB database. Resolves even if it did not exist. This is a
 *  destructive primitive — callers must only invoke it from an explicit,
 *  user-initiated deletion path. */
export function rawDeleteDatabase(dbName: string): Promise<void> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const req = idb.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Copy every object store (schema + all records) of `src` into a brand-new
 * `dst` database, preserving keyPath/autoIncrement/indexes. Non-destructive to
 * `src` (read-only there). Used to ARCHIVE a store aside before deletion.
 * Rejects if `src` cannot be opened.
 */
export function copyDatabase(src: string, dst: string): Promise<void> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise<void>((resolve, reject) => {
    const openSrc = idb.open(src);
    openSrc.onerror = () => reject(openSrc.error ?? new Error(`cannot open ${src}`));
    openSrc.onsuccess = () => {
      const source = openSrc.result;
      const storeNames = Array.from(source.objectStoreNames);
      // Snapshot each store's schema and records, then build dst to match.
      const snapshots: {
        name: string;
        keyPath: IDBObjectStore["keyPath"];
        autoIncrement: boolean;
        indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
        records: { key: IDBValidKey; value: unknown }[];
      }[] = [];
      let pending = storeNames.length;
      const finish = () => {
        source.close();
        const openDst = idb.open(dst, 1);
        openDst.onupgradeneeded = () => {
          const target = openDst.result;
          for (const s of snapshots) {
            const os = target.createObjectStore(s.name, {
              keyPath: s.keyPath as string | string[] | null,
              autoIncrement: s.autoIncrement,
            });
            for (const idx of s.indexes) {
              os.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
            }
          }
        };
        openDst.onerror = () => reject(openDst.error ?? new Error(`cannot create ${dst}`));
        openDst.onsuccess = () => {
          const target = openDst.result;
          if (snapshots.length === 0) {
            target.close();
            resolve();
            return;
          }
          const tx = target.transaction(
            snapshots.map((s) => s.name),
            "readwrite",
          );
          for (const s of snapshots) {
            const os = tx.objectStore(s.name);
            for (const r of s.records) {
              // Out-of-line keys (autoIncrement/no keyPath) must be passed explicitly.
              if (os.keyPath == null) os.put(r.value, r.key);
              else os.put(r.value);
            }
          }
          tx.oncomplete = () => {
            target.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error(`copy into ${dst} failed`));
        };
      };
      if (pending === 0) {
        finish();
        return;
      }
      const tx = source.transaction(storeNames, "readonly");
      for (const name of storeNames) {
        const os = tx.objectStore(name);
        const snap = {
          name,
          keyPath: os.keyPath,
          autoIncrement: os.autoIncrement,
          indexes: Array.from(os.indexNames).map((iName) => {
            const idx = os.index(iName);
            return {
              name: iName,
              keyPath: idx.keyPath as string | string[],
              unique: idx.unique,
              multiEntry: idx.multiEntry,
            };
          }),
          records: [] as { key: IDBValidKey; value: unknown }[],
        };
        snapshots.push(snap);
        const cursorReq = os.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            snap.records.push({ key: cursor.primaryKey, value: cursor.value });
            cursor.continue();
          } else if (--pending === 0) {
            finish();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error(`read ${name} failed`));
      }
    };
  });
}
