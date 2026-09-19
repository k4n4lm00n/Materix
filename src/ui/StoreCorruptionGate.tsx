// Blocking dialog shown when an account's canonical crypto-backed data-store is
// detected (read-only) as corrupted / half-written — the divergence a past
// crypto-failed session can leave behind. It never acts on its own: the store
// is only ever moved or deleted here, in direct response to an explicit user
// choice. Styled to match CryptoGate. See account.storeCorruption /
// storeMaintenance.ts for the (non-destructive) detection.
import { useEffect, useState } from "react";
import { accountManager } from "../core/manager";

export function StoreCorruptionGate() {
  const [affected, setAffected] = useState<{ key: string; userId: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const check = () => {
      setAffected(
        accountManager
          .list()
          .map((a) => accountManager.account(a.key))
          .filter((acc) => acc.storeCorruption === true)
          .map((acc) => ({ key: acc.key, userId: acc.session.userId })),
      );
    };
    check();
    const unsubs = accountManager.list().map((a) => accountManager.account(a.key).events.on("self", check));
    // Detection runs during account start; re-check shortly after mount.
    const t = setTimeout(check, 3000);
    return () => {
      unsubs.forEach((u) => u());
      clearTimeout(t);
    };
  }, []);

  if (affected.length === 0) return null;
  const target = affected[0];

  const run = async (action: "archive" | "delete") => {
    setBusy(true);
    setError(null);
    try {
      const acc = accountManager.account(target.key);
      if (action === "archive") await acc.archiveCorruptedStore();
      else await acc.deleteCorruptedStore();
      // Drop the handled account; the "self" emit also refreshes via check().
      setAffected((prev) => prev.filter((a) => a.key !== target.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Data-store corrupted"
      style={{
        position: "fixed",
        // NB: explicit sides, not `inset:0` — `inset` shorthand is Chromium 87+
        // and this gate must render on old WebViews (Chromium ~83).
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100001,
        background: "rgba(0,0,0,0.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: "100%",
          background: "#16181e",
          border: "1px solid #3a2020",
          borderRadius: 14,
          padding: "24px",
          textAlign: "center",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ fontSize: 44, lineHeight: 1 }} aria-hidden="true">
          ⚠️
        </div>
        <h2 style={{ margin: "12px 0 6px", color: "#ff6b6b" }}>Data-store corrupted</h2>
        <p style={{ color: "var(--text-1, #e6e8ec)", fontSize: 15, lineHeight: 1.5 }}>
          The data-store for the account <strong>{target.userId}</strong> looks corrupted.
        </p>
        <p style={{ color: "var(--text-2, #aab0bb)", fontSize: 14, lineHeight: 1.5 }}>
          This can happen if a previous session couldn't start encryption and left the encrypted
          store half-written. Nothing has been changed yet. Choose how to proceed:
        </p>
        <ul
          style={{
            color: "var(--text-2, #aab0bb)",
            fontSize: 13,
            lineHeight: 1.5,
            textAlign: "left",
            margin: "0 0 12px",
            paddingLeft: 18,
          }}
        >
          <li>
            <strong>Archive</strong> — move the affected store aside (kept for possible recovery),
            so it can't interfere. Recommended.
          </li>
          <li>
            <strong>Delete</strong> — permanently remove the affected store.
          </li>
        </ul>
        {error && (
          <p style={{ color: "#ff9d9d", fontSize: 13, lineHeight: 1.4 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button
            onClick={() => run("archive")}
            disabled={busy}
            style={{
              flex: 1,
              padding: "11px 14px",
              border: "1px solid #2b5a7a",
              borderRadius: 10,
              background: "#1b2a3a",
              color: "#d9ecff",
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Archive
          </button>
          <button
            onClick={() => run("delete")}
            disabled={busy}
            style={{
              flex: 1,
              padding: "11px 14px",
              border: "1px solid #7a2b2b",
              borderRadius: 10,
              background: "#3a1b1b",
              color: "#ffd9d9",
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
