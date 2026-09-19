# Compat crypto WASM (for old Android System WebViews)

`matrix_sdk_crypto_wasm_bg.{wasm,js}` here are a rebuild of
`@matrix-org/matrix-sdk-crypto-wasm` **18.3.1** with WebAssembly
**reference-types** and **multi-value** DISABLED
(`RUSTFLAGS="-C target-feature=-reference-types,-multivalue,+bulk-memory"`,
wasm-bindgen `--target bundler` without externref), so the crypto engine
instantiates on old Chromium WebViews (~Chromium 83, e.g. LineageOS 18.1 /
Android 11). The stock build needs Chromium 96+ (reference-types) / 85+
(multi-value) and fails to compile below that.

Used ONLY by the "compat" build variant, which `scripts/apply-compat-wasm.sh`
swaps into `node_modules` before the frontend build (see `.github/workflows/
android.yml` → "Build COMPAT APK"). The modern build keeps the stock upstream
WASM untouched.

Version pinned to the installed matrix-sdk-crypto-wasm; if that dependency is
bumped, this must be rebuilt from the matching tag or the glue ABI will
mismatch. See `REBUILD.md` for the reproducible recipe **and** the verification
commands that prove a rebuild is genuinely Cr83-safe.

## Verified feature set (static analysis)

Verified with two independent validators — `wasm-tools 1.219.1` and the npm
`wabt` binding — by validating the binary against incrementally-restricted
feature sets. The committed `matrix_sdk_crypto_wasm_bg.wasm` (sha256
`660cbb08…e910d31`, 7.63 MB) requires **only**:

| WebAssembly proposal            | Chrome shipped | Cr83? |
|---------------------------------|----------------|-------|
| mutable-globals                 | 74             | yes   |
| sign-extension operators        | 74             | yes   |
| non-trapping float-to-int (sat) | 75             | yes   |
| bulk-memory operations          | 75             | yes   |

and does **NOT** require:

| WebAssembly proposal            | Chrome shipped | Cr83? |
|---------------------------------|----------------|-------|
| multi-value                     | 85             | NO    |
| reference-types                 | 96             | NO    |
| SIMD (v128)                     | 91             | NO    |
| tail-call / threads / EH / GC   | later / n/a    | NO    |

i.e. it is validated to be **Chromium-83-safe at the bytecode-feature level**.
For contrast, the **stock** upstream 18.3.1 WASM (sha256 `580fc05a…a5998e`,
5.57 MB) fails to validate without `multi-value` AND `reference-types` — it
genuinely needs Chromium 96. The paired `matrix_sdk_crypto_wasm_bg.js` uses the
non-externref `getObject`/`heap[]` index ABI (no `externref` anywhere), which
matches the reference-types-disabled binary, so the JS↔WASM glue is internally
consistent and does not itself pull in reference-types.

Reproduce the diagnosis:

```sh
# with wasm-tools (bytecodealliance):
#   passes  => the module needs at most that feature set
wasm-tools validate --features=mvp,bulk-memory,sign-extension,saturating-float-to-int,mutable-global \
  matrix_sdk_crypto_wasm_bg.wasm    # exits 0  -> Cr83-safe
wasm-tools validate --features=mvp,bulk-memory,sign-extension,saturating-float-to-int,mutable-global \
  <stock>/matrix_sdk_crypto_wasm_bg.wasm  # errors: multi-value/reference-types -> Cr96
```

## IMPORTANT: static-safe is necessary, not sufficient

Passing the feature-set validation means a spec-conformant Chromium-83 engine
will *instantiate* the module — it clears the reference-types/multi-value gate
that blocks the stock build. It does **not** prove the whole E2EE flow works on
that WebView. `MatrixAccount.start()` (`src/core/account.ts`) wraps
`initRustCrypto()` in a try/catch and, on ANY throw, flips `cryptoAvailable=false`
and shows "Encryption unavailable"; the "needs Chromium 96+" text there is a
guessed cause in a comment / UI copy, not an actual Chromium-version check. So a
device can still show that banner for reasons unrelated to this WASM's feature
set (e.g. the device was served the MODERN/stock APK instead of the compat one,
a store/IndexedDB error, or a glue ABI mismatch after a dep bump).

**Before shipping, verify on a real old WebView** (Cr83 emulator AND a USB
LineageOS 18.1 / Android 11 device): confirm the installed APK is the *compat*
variant, that `OlmMachine` instantiates, and that a device-verification / SAS
exchange actually completes. Static validation is the pre-filter; the device is
the source of truth.
