// Per-account 32-byte key that encrypts the Rust crypto store at rest (passed
// to initRustCrypto's storageKey). Encrypting the crypto store is what keeps
// megolm/message keys from sitting on disk in the clear.
//
// SAFETY — this is deliberately NON-DESTRUCTIVE: a key is created ONLY when a
// brand-new account logs in (createStorageKey, called from manager.login/
// register), i.e. against a crypto store that does not exist yet. Accounts that
// were already logged in before this feature have no key record, so
// readStorageKey returns null and their crypto init path is unchanged — no
// migration, no prefix change, no store deletion. A previous attempt that reset
// the store bricked decryption; this design cannot, because it never touches an
// existing store.
//
// An optional app passcode wraps the SAME key with a passcode-derived AES-GCM
// key (PBKDF2-SHA256). Turning a passcode on/off only re-wraps the key — the
// key itself never changes, so the crypto store is never invalidated. If an
// unlock is cancelled, readStorageKey returns null and crypto init falls back to
// the unencrypted-capable path (contained, not bricked).

import { secretGet, secretSet } from "./storage";

const PREFIX = "materix.ckey.";
const ITERATIONS = 600_000;

// Stored value is either a raw base64 key (plain, the default and the legacy
// format) or a JSON object describing a passcode-wrapped key.
interface PasscodeRecord {
  v: 1;
  mode: "passcode";
  salt: string;
  iv: string;
  wrapped: string;
  iterations: number;
}

const toB64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const u = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(u);
  return u;
}

function parsePasscodeRecord(raw: string): PasscodeRecord | null {
  try {
    const o = JSON.parse(raw) as PasscodeRecord;
    return o && o.mode === "passcode" ? o : null;
  } catch {
    return null; // not JSON → a raw base64 plain key
  }
}

async function deriveWrapKey(
  passcode: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passcode), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Prompt for a passcode; return the entered value, or null to cancel. */
export type PasscodePrompt = (ctx: { accountKey: string; retry: boolean }) => Promise<string | null>;

// The UI registers a prompt at startup; account init uses it to unlock a
// passcode-protected key without the core layer importing the UI.
let registeredPrompt: PasscodePrompt | undefined;
export function registerPasscodePrompt(fn: PasscodePrompt | undefined): void {
  registeredPrompt = fn;
}

/**
 * Create and persist a fresh 32-byte key for an account. Call at LOGIN time,
 * before the client's crypto is initialised, so the fresh store is encrypted.
 * No-op-safe: if a key already exists it is returned unchanged.
 */
export async function createStorageKey(accountKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const existing = await readStorageKey(accountKey);
  if (existing) return existing;
  const key = randomBytes(32);
  await secretSet(PREFIX + accountKey, toB64(key));
  return key;
}

/**
 * Return the account's crypto-store key, or null if none exists (legacy
 * unencrypted account) or the passcode unlock is cancelled. When the key is
 * passcode-wrapped, `prompt` (or the registered prompt) is used to unlock it,
 * retrying on a wrong passcode.
 */
export async function readStorageKey(
  accountKey: string,
  prompt: PasscodePrompt | undefined = registeredPrompt,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const raw = await secretGet(PREFIX + accountKey);
  if (!raw) return null;

  const rec = parsePasscodeRecord(raw);
  if (!rec) {
    // Plain (raw base64) key.
    try {
      const key = fromB64(raw);
      return key.length === 32 ? key : null;
    } catch {
      return null;
    }
  }

  // Passcode-wrapped: unlock.
  const salt = fromB64(rec.salt);
  const iv = fromB64(rec.iv);
  const wrapped = fromB64(rec.wrapped);
  for (let retry = false; ; retry = true) {
    if (!prompt) return null; // no way to unlock → degrade to no-crypto for this account
    const pass = await prompt({ accountKey, retry });
    if (pass == null) return null; // cancelled
    try {
      const wk = await deriveWrapKey(pass, salt, rec.iterations);
      const key = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wk, wrapped);
      return new Uint8Array(key) as Uint8Array<ArrayBuffer>;
    } catch {
      // Wrong passcode (GCM auth failure) → loop and prompt again.
    }
  }
}

/**
 * Whether ANY at-rest key record exists for this account, unlockable or not.
 * DATA-SAFETY: MatrixAccount.start uses this as a gate — when a record exists
 * but readStorageKey() returned null (passcode cancelled, unreadable record),
 * the encrypted crypto store must not be opened keyless; crypto init fails up
 * front and the session runs against the separate clear-text fallback store.
 */
export async function hasStorageKeyRecord(accountKey: string): Promise<boolean> {
  return (await secretGet(PREFIX + accountKey)) != null;
}

export async function hasPasscode(accountKey: string): Promise<boolean> {
  const raw = await secretGet(PREFIX + accountKey);
  return !!raw && !!parsePasscodeRecord(raw);
}

/** Enable/replace a passcode by re-wrapping the (already unlocked) key. */
export async function setPasscode(
  accountKey: string,
  key: Uint8Array<ArrayBuffer>,
  passcode: string,
): Promise<void> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wk = await deriveWrapKey(passcode, salt, ITERATIONS);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wk, key));
  const rec: PasscodeRecord = {
    v: 1,
    mode: "passcode",
    salt: toB64(salt),
    iv: toB64(iv),
    wrapped: toB64(wrapped),
    iterations: ITERATIONS,
  };
  await secretSet(PREFIX + accountKey, JSON.stringify(rec));
}

/** Disable the passcode: store the key plain again (still keychain-backed on desktop). */
export async function clearPasscode(accountKey: string, key: Uint8Array<ArrayBuffer>): Promise<void> {
  await secretSet(PREFIX + accountKey, toB64(key));
}
