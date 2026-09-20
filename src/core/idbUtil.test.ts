// Regression guard for the live Chromium-83 defect: matrix-js-sdk's
// LocalIndexedDBStoreBackend prepends "matrix-js-sdk:" to every sync-store
// dbName, so raw-indexedDB code (probe/copy/delete in storeMaintenance and
// account.destroy) must use the SAME prefixed name the SDK produces. This test
// ties syncDbName() to the REAL SDK backend so the two can never silently drift
// (e.g. if a future SDK bump changes the prefix).
import { describe, it, expect } from "vitest";
import { IndexedDBStore } from "matrix-js-sdk";
import {
  IDB_PREFIX,
  archivedSyncDbName,
  plainSyncDbName,
  syncDbName,
  syncDbSuffix,
} from "./idbUtil";

describe("sync-store name helpers vs. the matrix-js-sdk backend", () => {
  it("syncDbName(key) equals the real backend's underlying dbName", () => {
    // The backend constructor only stores the indexedDB object and computes
    // `dbName = "matrix-js-sdk:" + suffix`, so a minimal truthy factory suffices.
    const store = new IndexedDBStore({
      indexedDB: {} as unknown as IDBFactory,
      dbName: syncDbSuffix("k1"),
    });
    const backendName = (store as unknown as { backend: { dbName: string } }).backend.dbName;

    expect(backendName).toBe(syncDbName("k1"));
    expect(backendName).toBe("matrix-js-sdk:materix-sync-k1");
  });

  it("all sync-name helpers share the one prefix", () => {
    expect(IDB_PREFIX).toBe("matrix-js-sdk:");
    expect(syncDbName("k1")).toBe("matrix-js-sdk:materix-sync-k1");
    expect(plainSyncDbName("k1")).toBe("matrix-js-sdk:materix-sync-plain-k1");
    expect(archivedSyncDbName("k1")).toBe("matrix-js-sdk:materix-sync-archived-k1");
  });
});
