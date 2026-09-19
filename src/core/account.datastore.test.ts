// Regression tests for the data-safety invariant in MatrixAccount.start():
// the crypto-backed store namespace (`materix-sync-<key>`) may only ever be
// opened by a session whose crypto engine initialised; any crypto failure must
// route to the separate clear-text `materix-sync-plain-<key>` namespace and
// leave the crypto-backed one untouched. See the invariant block in account.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mocks ------------------------------------------------------------------

const constructedStores: { dbName: string; startup: ReturnType<typeof vi.fn> }[] = [];

const fakeClient = () => ({
  on: vi.fn(),
  off: vi.fn(),
  initRustCrypto: vi.fn().mockResolvedValue(undefined),
  startClient: vi.fn().mockResolvedValue(undefined),
  stopClient: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  clearStores: vi.fn().mockResolvedValue(undefined),
  getAccountData: vi.fn().mockReturnValue(undefined),
  store: undefined as unknown,
});
let client = fakeClient();

vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(() => client),
  IndexedDBStore: class {
    dbName: string;
    startup = vi.fn().mockResolvedValue(undefined);
    deleteAllData = vi.fn().mockResolvedValue(undefined);
    constructor(opts: { dbName: string }) {
      this.dbName = opts.dbName;
      constructedStores.push(this as never);
    }
  },
  BeaconEvent: {},
  ClientEvent: {},
  EventType: {},
  MatrixEventEvent: {},
  RoomEvent: {},
  RoomMemberEvent: {},
  RoomStateEvent: {},
  SyncState: {},
}));
vi.mock("matrix-js-sdk/lib/crypto-api/CryptoEvent", () => ({ CryptoEvent: {} }));
// account.ts transitively pulls roomHandle → markdown → DOMPurify, which needs
// a real DOM; neither is exercised by these store-routing tests.
vi.mock("./roomHandle", () => ({ RoomHandle: class {} }));
vi.mock("./markdown", () => ({ previewText: (s: string) => s }));
vi.mock("./crypto", () => ({
  CryptoFacade: class {
    bind = vi.fn();
    attach = vi.fn();
  },
  cryptoCallbacks: {},
}));
vi.mock("./calls", () => ({
  CallManager: class {
    bind = vi.fn();
  },
}));
vi.mock("./cryptoStoreKey", () => ({
  readStorageKey: vi.fn().mockResolvedValue(null),
  hasStorageKeyRecord: vi.fn().mockResolvedValue(false),
}));

import { MatrixAccount } from "./account";
import { hasStorageKeyRecord, readStorageKey } from "./cryptoStoreKey";
import type { SessionData } from "./types";

const session: SessionData = {
  userId: "@u:hs",
  deviceId: "DEV",
  accessToken: "tok",
  homeserverUrl: "https://hs",
};

beforeEach(() => {
  constructedStores.length = 0;
  client = fakeClient();
  vi.mocked(readStorageKey).mockResolvedValue(null);
  vi.mocked(hasStorageKeyRecord).mockResolvedValue(false);
  const deleteDatabase = vi.fn();
  (globalThis as Record<string, unknown>).indexedDB = { deleteDatabase };
  (globalThis as Record<string, unknown>).window = globalThis;
});

// ---- tests ------------------------------------------------------------------

describe("MatrixAccount.start data-store routing", () => {
  it("crypto OK: opens exactly the canonical materix-sync-<key> store, after crypto init", async () => {
    const acc = new MatrixAccount("k1", session);
    await acc.start();

    expect(acc.cryptoAvailable).toBe(true);
    expect(constructedStores.map((s) => s.dbName)).toEqual(["materix-sync-k1"]);
    expect(constructedStores[0].startup).toHaveBeenCalledOnce();
    expect(client.store).toBe(constructedStores[0]);
    // Namespace chosen after the crypto outcome: init ran before the store existed.
    expect(client.initRustCrypto.mock.invocationCallOrder[0]).toBeLessThan(
      constructedStores[0].startup.mock.invocationCallOrder[0],
    );
    expect(client.initRustCrypto).toHaveBeenCalledWith({ cryptoDatabasePrefix: "materix-crypto-k1" });
    expect(client.startClient).toHaveBeenCalledOnce();
  });

  it("passes the at-rest storageKey through unchanged when one exists", async () => {
    const key = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>;
    vi.mocked(readStorageKey).mockResolvedValue(key);
    vi.mocked(hasStorageKeyRecord).mockResolvedValue(true);
    const acc = new MatrixAccount("k1", session);
    await acc.start();

    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: "materix-crypto-k1",
      storageKey: key,
    });
    expect(constructedStores.map((s) => s.dbName)).toEqual(["materix-sync-k1"]);
  });

  it("crypto init failure: falls back to materix-sync-plain-<key>, never touching the canonical store", async () => {
    client.initRustCrypto.mockRejectedValue(new Error("WebAssembly.instantiate: reference-types"));
    const acc = new MatrixAccount("k1", session);
    await acc.start();

    expect(acc.cryptoAvailable).toBe(false);
    expect(acc.cryptoError).toMatch(/reference-types/);
    // THE invariant: only the plain fallback db is ever constructed/opened.
    expect(constructedStores.map((s) => s.dbName)).toEqual(["materix-sync-plain-k1"]);
    expect(constructedStores[0].startup).toHaveBeenCalledOnce();
    // App still runs (unencrypted) against the fallback store.
    expect(client.startClient).toHaveBeenCalledOnce();
    // Nothing was deleted.
    const idb = (globalThis as Record<string, unknown>).indexedDB as { deleteDatabase: ReturnType<typeof vi.fn> };
    expect(idb.deleteDatabase).not.toHaveBeenCalled();
  });

  it("locked at-rest key: refuses to open the encrypted crypto store keyless and falls back", async () => {
    vi.mocked(readStorageKey).mockResolvedValue(null); // unlock cancelled / unreadable
    vi.mocked(hasStorageKeyRecord).mockResolvedValue(true); // ...but a key record exists
    const acc = new MatrixAccount("k1", session);
    await acc.start();

    // The encrypted crypto store must not even be opened without its key.
    expect(client.initRustCrypto).not.toHaveBeenCalled();
    expect(acc.cryptoAvailable).toBe(false);
    expect(constructedStores.map((s) => s.dbName)).toEqual(["materix-sync-plain-k1"]);
  });

  it("destroy (explicit sign-out) is the only deletion path and removes both namespaces", async () => {
    const acc = new MatrixAccount("k1", session);
    await acc.start();
    await acc.destroy();

    const idb = (globalThis as Record<string, unknown>).indexedDB as { deleteDatabase: ReturnType<typeof vi.fn> };
    const deleted = idb.deleteDatabase.mock.calls.map((c) => c[0]);
    expect(deleted).toEqual(
      expect.arrayContaining([
        "materix-sync-k1",
        "materix-sync-plain-k1",
        "materix-crypto-k1::matrix-sdk-crypto",
        "materix-crypto-k1::matrix-sdk-crypto-meta",
      ]),
    );
  });
});
