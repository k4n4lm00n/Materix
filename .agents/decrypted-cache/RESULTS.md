# Issue #4 read fast-path — results (living doc)

Branch: `e2ee/persistent-decrypted-cache` (base 0e4e37e, write side).
Goal: render cached plaintext for still-encrypted events on cold start; SDK
stays source of truth; edit/redaction/sign-out invalidation; all best-effort.

## Status

| # | Item | Status |
|---|------|--------|
| 1 | In-memory warm layer (batch IndexedDB load -> Map -> re-render bump) | in progress |
| 2 | Render seam in roomHandle.ts (cache while SDK hasn't decrypted) | in progress |
| 3 | Edit (m.replace) invalidation + keep redaction/destroy | in progress |
| 4 | Best-effort (cache fault never breaks messaging) | in progress |
| 5 | tsc --noEmit + pnpm build | pending |
| 6 | Behavioral verify: cache-hit renders plaintext on cold start | pending |
| 7 | Behavioral verify: SDK takes over, no divergence | pending |
| 8 | Behavioral verify: edit + redaction invalidation, sign-out deletes DB | pending |

## Evidence

(populated as verification runs)
