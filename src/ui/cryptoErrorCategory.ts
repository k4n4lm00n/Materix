// Categorize the raw error string that initRustCrypto() threw (stored on the
// account as `cryptoError`) into a small set, so CryptoGate can show an
// ACCURATE cause instead of always blaming an old WebView. Pure + dependency-
// free so it is trivially unit-testable.

export type CryptoErrorCategory = "wasm" | "datastore" | "unknown";

// A WASM compile/instantiate failure — the genuine "old WebView can't run the
// crypto engine" class. Checked FIRST.
const WASM_RE =
  /compileerror|webassembly|instantiate|reference-types|multi-?value|return count of 2 exceeds internal limit of 1/i;

// A local data-store / IndexedDB failure — NOT a WebView problem.
const DATASTORE_RE =
  /indexeddb|\bidb\b|database|datastore|objectstore|\bstore\b|quotaexceeded|notfounderror|unknownerror|transactioninactive|invalidstate/i;

/** Map a `cryptoError` string to its category. WASM is matched before
 *  data-store so a genuine WASM failure is never mislabeled. */
export function categorizeCryptoError(err: string | undefined | null): CryptoErrorCategory {
  const s = err ?? "";
  if (WASM_RE.test(s)) return "wasm";
  if (DATASTORE_RE.test(s)) return "datastore";
  return "unknown";
}
