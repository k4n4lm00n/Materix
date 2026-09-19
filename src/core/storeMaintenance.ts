// Corruption detection + user-chosen recovery (ARCHIVE / DELETE) for the
// crypto-backed data-store namespace of an account. Orchestration only; the
// raw IndexedDB primitives live in idbUtil.ts (so this is unit-testable).
//
// DATA-SAFETY: detection is strictly read-only — it never moves or deletes
// anything. Only archiveCanonicalStores / deleteCanonicalStores mutate the
// on-disk stores, and both are reached ONLY from an explicit user choice in
// StoreCorruptionGate. Neither touches the clear-text fallback
// (`materix-sync-plain-<key>`), which is the live session's store.

import { copyDatabase, listDatabaseNames, probeSyncStore, rawDeleteDatabase } from "./idbUtil";

// Canonical (crypto-backed) namespace, kept in lock-step with account.ts.
const syncDb = (key: string) => `materix-sync-${key}`;
const cryptoDb = (key: string) => `materix-crypto-${key}::matrix-sdk-crypto`;
const cryptoMetaDb = (key: string) => `materix-crypto-${key}::matrix-sdk-crypto-meta`;

// Fixed, deterministic archive slot (no timestamp/random — see task spec).
const archivedSyncDb = (key: string) => `materix-sync-archived-${key}`;
const archivedCryptoDb = (key: string) => `materix-crypto-archived-${key}::matrix-sdk-crypto`;
const archivedCryptoMetaDb = (key: string) => `materix-crypto-archived-${key}::matrix-sdk-crypto-meta`;

/**
 * Read-only check: does the canonical crypto-backed store look corrupted /
 * half-written? Returns true ONLY for the genuine divergence a crypto-failed
 * session leaves behind:
 *
 *   - the canonical sync store exists and has advanced its sync token
 *     (i.e. it holds real synced data), BUT the rust crypto store is missing;
 *     or
 *   - the canonical sync store is present but cannot be opened/read
 *     (half-written / corrupt).
 *
 * It deliberately returns FALSE for the two look-alike-but-healthy cases, to
 * avoid false positives:
 *   - a fresh / first-run account (no sync DB, or an empty one with no token);
 *   - a fully intact encrypted account whose crypto engine merely can't run on
 *     this device (old WebView) — there BOTH stores exist and agree, so the
 *     user just needs to fix their WebView (handled by CryptoGate), not lose
 *     data.
 *
 * Only meaningful to call when crypto init did NOT succeed this launch; if
 * crypto is up, the canonical store was opened cleanly and is by definition
 * consistent.
 */
export async function detectCanonicalStoreCorruption(key: string): Promise<boolean> {
  const names = await listDatabaseNames();
  // When databases() is unavailable we can't cheaply know the crypto store's
  // existence; fall back to probing only the sync store and flag solely the
  // unambiguous "half-written" (open error) case — never the ambiguous ones.
  if (names === null) {
    return (await probeSyncStore(syncDb(key))) === "error";
  }

  if (!names.includes(syncDb(key))) return false; // no canonical store → fresh
  const probe = await probeSyncStore(syncDb(key));
  if (probe === "error") return true; // half-written / unreadable
  if (probe !== "hasData") return false; // empty/fresh → nothing valuable at risk

  // Sync store holds real data. If the crypto store is gone, that's the
  // divergence. If it's present, the store is healthy (crypto engine issue).
  const cryptoPresent = names.includes(cryptoDb(key)) || names.includes(cryptoMetaDb(key));
  return !cryptoPresent;
}

/**
 * ARCHIVE: move the canonical crypto-backed store(s) aside to a fixed,
 * inspectable archive slot, then remove the originals. Copy-then-delete so
 * nothing is silently discarded. Refuses to overwrite an existing archive.
 * Never touches the clear-text fallback store.
 */
export async function archiveCanonicalStores(key: string): Promise<void> {
  const names = (await listDatabaseNames()) ?? [];
  if (
    names.includes(archivedSyncDb(key)) ||
    names.includes(archivedCryptoDb(key)) ||
    names.includes(archivedCryptoMetaDb(key))
  ) {
    throw new Error(
      `An archive already exists for account ${key}; refusing to overwrite it. ` +
        `Inspect or remove the existing archive first.`,
    );
  }

  const jobs: [string, string][] = [
    [syncDb(key), archivedSyncDb(key)],
    [cryptoDb(key), archivedCryptoDb(key)],
    [cryptoMetaDb(key), archivedCryptoMetaDb(key)],
  ];
  // Copy only the stores that actually exist. Copy every one BEFORE deleting
  // any, so a mid-way failure can't leave us with a deleted-but-uncopied store.
  const copied: string[] = [];
  const listNow = (await listDatabaseNames()) ?? names;
  for (const [from, to] of jobs) {
    if (!listNow.includes(from)) continue;
    await copyDatabase(from, to);
    copied.push(from);
  }
  for (const from of copied) {
    await rawDeleteDatabase(from);
  }
}

/**
 * DELETE: the sanctioned, explicit-user-action removal of the canonical
 * crypto-backed store(s). Same allowlist semantics as account.destroy(), but
 * scoped to the crypto-backed namespace only — the clear-text fallback (the
 * store the app is currently running on) is left intact.
 */
export async function deleteCanonicalStores(key: string): Promise<void> {
  await rawDeleteDatabase(syncDb(key));
  await rawDeleteDatabase(cryptoDb(key));
  await rawDeleteDatabase(cryptoMetaDb(key));
}
