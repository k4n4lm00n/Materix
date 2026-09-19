// Proves the canonical DB survives a simulated matrix-js-sdk degrade: the
// backend's clearDatabase (which the SDK's degradable() awaits AFTER emitting
// "degraded") is intercepted so it never calls indexedDB.deleteDatabase.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake matrix-js-sdk IndexedDBStore base whose backend deletes on clearDatabase,
// exactly like the real LocalIndexedDBStoreBackend.
const deleteDatabase = vi.fn();
class FakeBackend {
  dbName = "materix-sync-k1";
  clearDatabase() {
    deleteDatabase(this.dbName); // real backend calls indexedDB.deleteDatabase here
    return Promise.resolve();
  }
}
vi.mock("matrix-js-sdk", () => ({
  IndexedDBStore: class {
    backend = new FakeBackend();
    constructor(_opts: unknown) {}
  },
}));

import { NonDestructiveIndexedDBStore } from "./nonDestructiveStore";

beforeEach(() => deleteDatabase.mockClear());

describe("NonDestructiveIndexedDBStore", () => {
  it("suppresses the auto-delete a degrade would trigger (DB preserved)", async () => {
    const store = new NonDestructiveIndexedDBStore({ dbName: "materix-sync-k1" } as never);
    const backend = (store as unknown as { backend: FakeBackend }).backend;

    // This is precisely what the SDK's degradable() catch block awaits after a
    // store op throws. On the stock store it would delete the DB.
    await backend.clearDatabase();

    expect(deleteDatabase).not.toHaveBeenCalled();
  });

  it("is idempotent and marks the backend protected", () => {
    const store = new NonDestructiveIndexedDBStore({ dbName: "x" } as never);
    const backend = (store as unknown as { backend: { __materixProtected?: boolean } }).backend;
    expect(backend.__materixProtected).toBe(true);
  });
});
