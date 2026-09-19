import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./idbUtil", () => ({
  listDatabaseNames: vi.fn(),
  probeSyncStore: vi.fn(),
  copyDatabase: vi.fn().mockResolvedValue(undefined),
  rawDeleteDatabase: vi.fn().mockResolvedValue(undefined),
}));

import {
  archiveCanonicalStores,
  deleteCanonicalStores,
  detectCanonicalStoreCorruption,
} from "./storeMaintenance";
import { copyDatabase, listDatabaseNames, probeSyncStore, rawDeleteDatabase } from "./idbUtil";

const SYNC = "materix-sync-k1";
const CRYPTO = "materix-crypto-k1::matrix-sdk-crypto";
const CRYPTO_META = "materix-crypto-k1::matrix-sdk-crypto-meta";
const ARCH_SYNC = "materix-sync-archived-k1";

beforeEach(() => {
  vi.mocked(listDatabaseNames).mockReset();
  vi.mocked(probeSyncStore).mockReset();
  vi.mocked(copyDatabase).mockReset().mockResolvedValue(undefined);
  vi.mocked(rawDeleteDatabase).mockReset().mockResolvedValue(undefined);
});

describe("detectCanonicalStoreCorruption (read-only)", () => {
  it("fresh/first-run account (no canonical sync DB) → false, and touches nothing", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([]);
    expect(await detectCanonicalStoreCorruption("k1")).toBe(false);
    expect(probeSyncStore).not.toHaveBeenCalled();
    expect(copyDatabase).not.toHaveBeenCalled();
    expect(rawDeleteDatabase).not.toHaveBeenCalled();
  });

  it("empty sync DB (no token) → false (guards a fresh account with a stub DB)", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC]);
    vi.mocked(probeSyncStore).mockResolvedValue("empty");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(false);
  });

  it("intact encrypted account, crypto engine just can't run (both stores present) → false", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC, CRYPTO, CRYPTO_META]);
    vi.mocked(probeSyncStore).mockResolvedValue("hasData");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(false);
  });

  it("divergence: sync has data but crypto store missing → true", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC]);
    vi.mocked(probeSyncStore).mockResolvedValue("hasData");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(true);
    // still read-only
    expect(copyDatabase).not.toHaveBeenCalled();
    expect(rawDeleteDatabase).not.toHaveBeenCalled();
  });

  it("half-written / unreadable sync DB → true", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC, CRYPTO]);
    vi.mocked(probeSyncStore).mockResolvedValue("error");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(true);
  });

  it("no databases() support: flags only the unambiguous open-error case", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue(null);
    vi.mocked(probeSyncStore).mockResolvedValue("error");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(true);
    vi.mocked(probeSyncStore).mockResolvedValue("hasData");
    expect(await detectCanonicalStoreCorruption("k1")).toBe(false);
  });
});

describe("archiveCanonicalStores (move, not discard)", () => {
  it("copies each existing store to its archive slot BEFORE deleting the original", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC, CRYPTO]);
    await archiveCanonicalStores("k1");

    expect(copyDatabase).toHaveBeenCalledWith(SYNC, ARCH_SYNC);
    expect(copyDatabase).toHaveBeenCalledWith(CRYPTO, "materix-crypto-archived-k1::matrix-sdk-crypto");
    // crypto-meta didn't exist → not copied.
    expect(copyDatabase).toHaveBeenCalledTimes(2);
    // Originals deleted, but only after being copied.
    expect(rawDeleteDatabase).toHaveBeenCalledWith(SYNC);
    expect(rawDeleteDatabase).toHaveBeenCalledWith(CRYPTO);
    expect(rawDeleteDatabase).not.toHaveBeenCalledWith(CRYPTO_META);
    const lastCopy = Math.max(...vi.mocked(copyDatabase).mock.invocationCallOrder);
    const firstDelete = Math.min(...vi.mocked(rawDeleteDatabase).mock.invocationCallOrder);
    expect(lastCopy).toBeLessThan(firstDelete);
  });

  it("refuses to overwrite an existing archive (never clobbers a prior archive)", async () => {
    vi.mocked(listDatabaseNames).mockResolvedValue([SYNC, ARCH_SYNC]);
    await expect(archiveCanonicalStores("k1")).rejects.toThrow(/archive already exists/i);
    expect(copyDatabase).not.toHaveBeenCalled();
    expect(rawDeleteDatabase).not.toHaveBeenCalled();
  });
});

describe("deleteCanonicalStores (explicit removal)", () => {
  it("removes the crypto-backed stores and never the clear-text fallback", async () => {
    await deleteCanonicalStores("k1");
    const deleted = vi.mocked(rawDeleteDatabase).mock.calls.map((c) => c[0]);
    expect(deleted).toEqual([SYNC, CRYPTO, CRYPTO_META]);
    expect(deleted).not.toContain("materix-sync-plain-k1");
    expect(copyDatabase).not.toHaveBeenCalled();
  });
});
