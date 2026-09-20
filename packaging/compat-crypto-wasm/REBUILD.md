# Rebuilding the Cr83-compat crypto WASM

The committed `matrix_sdk_crypto_wasm_bg.{wasm,js}` are **already** a correct,
Chromium-83-safe rebuild of `@matrix-org/matrix-sdk-crypto-wasm` (verified — see
`README.md`). You only need to rebuild when the pinned dependency version
changes (currently **18.3.1**), because the wasm-bindgen glue ABI is
version-specific and a mismatch makes `initRustCrypto()` throw.

This file is the reproducible recipe + the verification gate. Run it wherever
the toolchain and crate registry are reachable (it needs `wasm32-unknown-unknown`
+ the crate source from crates.io/GitHub, which were NOT reachable in the
environment where this diagnosis was done — crates.io returned HTTP 403 and the
`wasm32-unknown-unknown` rustup target was not installed, so the current binary
was NOT re-generated here, only validated).

## 0. Target feature facts (why the flags below)

Chromium 83 (LineageOS 18.1 / Android 11) supports these WebAssembly proposals:
mutable-globals (Cr74), sign-extension (Cr74), non-trapping float-to-int /
saturating (Cr75), bulk-memory (Cr75). It does NOT support: multi-value (Cr85),
reference-types (Cr96), SIMD (Cr91). The rebuild must therefore emit a module
that uses ONLY the first group.

- `-reference-types`  — the one that matters most; also drop externref in glue.
- `-multivalue`       — Rust/LLVM otherwise returns aggregates via multi-result.
- `+bulk-memory`      — safe on Cr83 and keeps memory ops compact.
- sign-extension and saturating-float-to-int are Cr83-safe, so they need NOT be
  disabled (and disabling sign-ext would require an ancient target-cpu). Leave
  them on. Do NOT enable SIMD.

## 1. Toolchain

```sh
# Rust — a stable toolchain works; pin one for reproducibility.
rustup toolchain install 1.79.0           # any recent stable is fine
rustup target add wasm32-unknown-unknown --toolchain 1.79.0

# wasm-bindgen-cli MUST match the wasm-bindgen crate version the matrix crate
# depends on for the tag you build (check its Cargo.lock). Mismatch => broken glue.
cargo install wasm-bindgen-cli --version <exact-version-from-Cargo.lock>

# Validators used to prove Cr83-safety (either is sufficient):
cargo install wasm-tools           # or download the prebuilt release binary
# npm i wabt                       # pure-JS alternative, no crates.io needed
```

## 2. Get the matching crate source

```sh
git clone https://github.com/matrix-org/matrix-rust-sdk-crypto-wasm
cd matrix-rust-sdk-crypto-wasm
git checkout v18.3.1              # <-- the tag matching package.json's pinned version
```

(The repo bundles/points at the matrix-rust-sdk crypto crate; a plain
`npm ci` there fetches its JS build deps. The build is driven by its own
`Makefile` / `npm run build`, which internally calls cargo + wasm-bindgen.)

## 3. Build with the Cr83 feature flags

Bypass the repo's default `wasm-pack`/`--target web` path; build the cdylib
directly then run wasm-bindgen with the bundler target (matches how Materix
consumes it), with reference-types/multivalue off:

```sh
RUSTFLAGS="-C target-feature=-reference-types,-multivalue,+bulk-memory" \
  cargo build --release --target wasm32-unknown-unknown

wasm-bindgen \
  --target bundler \
  --out-dir pkg-compat \
  --omit-default-module-path \
  target/wasm32-unknown-unknown/release/matrix_sdk_crypto_wasm.wasm
# NOTE: do NOT pass --reference-types; keep externref out of the glue so the
# emitted .js uses the getObject/heap[] index ABI (this is what the committed
# glue does — no `externref` string anywhere in it).
```

If the wasm-bindgen output still shows reference-types (some versions inject an
externref table for the closure/anyref shim), post-process with:

```sh
wasm-tools transform / walrus, or an older wasm-bindgen (<0.2.87) that defaults
to the non-reference-types ABI. wasm-bindgen 0.2.8x with the WASM_BINDGEN_
EXTERNREF unset produces the heap-index ABI seen in the committed glue.
```

## 4. VERIFY (this is the acceptance gate — do not skip)

```sh
W=pkg-compat/matrix_sdk_crypto_wasm_bg.wasm

# MUST pass (exit 0) with ONLY the Cr83 feature set:
wasm-tools validate \
  --features=mvp,bulk-memory,sign-extension,saturating-float-to-int,mutable-global "$W"

# MUST FAIL (proves you didn't accidentally leave them in):
wasm-tools validate --features=mvp "$W"                 # expect: needs a feature
# And confirm the glue has no externref:
grep -c externref pkg-compat/matrix_sdk_crypto_wasm_bg.js   # expect 0
```

Only if the first command exits 0 (and the stock build fails it) is the rebuild
genuinely Cr83-safe.

## 5. Install + on-device verify

```sh
cp pkg-compat/matrix_sdk_crypto_wasm_bg.js   packaging/compat-crypto-wasm/
cp pkg-compat/matrix_sdk_crypto_wasm_bg.wasm packaging/compat-crypto-wasm/
# update README.md's sha256 + size + verified feature table
```

Then build the compat APK (`.github/workflows/android.yml` → "Build COMPAT APK",
which runs `scripts/apply-compat-wasm.sh`) and **test on a real Chromium-83
WebView — emulator AND a USB LineageOS 18.1 device** — that `OlmMachine`
instantiates and a SAS device-verification completes. Static validation clears
the feature gate; only the device proves the full E2EE flow.
