#!/usr/bin/env bash
# Swap the stock crypto WASM for the old-WebView-compatible rebuild (see
# packaging/compat-crypto-wasm/README.md). Run BEFORE the frontend build when
# producing the "compat" APK variant. No-op-safe to run once.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$here/packaging/compat-crypto-wasm"
# Resolve the (pnpm-symlinked) installed package dir, then its pkg/ folder.
link="$here/node_modules/@matrix-org/matrix-sdk-crypto-wasm"
test -e "$link" || { echo "crypto-wasm package not installed at $link"; exit 1; }
pkg="$(readlink -f "$link")/pkg"
test -f "$src/matrix_sdk_crypto_wasm_bg.wasm" || { echo "compat wasm missing in $src"; exit 1; }
test -d "$pkg" || { echo "crypto-wasm pkg dir not found: $pkg"; exit 1; }
cp "$src/matrix_sdk_crypto_wasm_bg.js"   "$pkg/matrix_sdk_crypto_wasm_bg.js"
cp "$src/matrix_sdk_crypto_wasm_bg.wasm" "$pkg/matrix_sdk_crypto_wasm_bg.wasm"
echo "compat crypto WASM applied to $pkg"

# --- CSP: allow WASM codegen on OLD WebViews (compat variant ONLY) -----------
# The app ships a strict Content-Security-Policy whose script-src is
#   'self' 'wasm-unsafe-eval'
# but 'wasm-unsafe-eval' is a Chromium 97+ keyword. On the old System WebViews
# the compat build targets (Chromium ~83, e.g. LineageOS 18.1 / Android 11) it
# is UNKNOWN and silently ignored, so WASM code generation is disallowed and
# crypto dies with "CompileError: Wasm code generation disallowed by embedder".
# Those older engines need the pre-standard 'unsafe-eval' keyword to permit WASM
# codegen. We add it ONLY here (the compat step) so the modern APK and the
# desktop build keep the tighter CSP untouched — this script runs solely for the
# compat variant and never for the modern/desktop builds. Everything else in the
# CSP stays byte-identical.
CSP_FROM="script-src 'self' 'wasm-unsafe-eval'"
CSP_TO="script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'"

patch_csp() {
  local file="$1"
  test -f "$file" || { echo "CSP file not found: $file"; exit 1; }
  # Idempotent: already patched (checked FIRST because CSP_FROM is a prefix of
  # CSP_TO, so a plain CSP_FROM match would also hit an already-patched file).
  if grep -qF "$CSP_TO" "$file"; then
    echo "CSP already includes 'unsafe-eval' in $file (idempotent, no change)"
    return 0
  fi
  # Fail loudly if the directive isn't the exact string we expect — never leave
  # the CSP unpatched silently (that reintroduces the Cr<97 crypto break).
  if ! grep -qF "$CSP_FROM" "$file"; then
    echo "::error::apply-compat-wasm.sh: expected script-src \"$CSP_FROM\" not found in $file. Upstream likely changed the CSP; refusing to build a compat variant with a CSP that blocks WASM on old WebViews. Update this script to match." >&2
    exit 1
  fi
  local tmp; tmp="$(mktemp)"
  # '#' is a safe delimiter (neither string contains it); no regex metachars.
  sed "s#${CSP_FROM}#${CSP_TO}#g" "$file" > "$tmp" && mv "$tmp" "$file"
  grep -qF "$CSP_TO" "$file" || { echo "::error::CSP patch failed to apply in $file" >&2; exit 1; }
  echo "CSP patched in $file: added 'unsafe-eval' to script-src (old-WebView WASM codegen)"
}

patch_csp "$here/src-tauri/tauri.conf.json"
patch_csp "$here/index.html"
