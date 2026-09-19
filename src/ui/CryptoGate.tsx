// Loud, blocking warning shown when the E2EE crypto engine failed to start
// (initRustCrypto threw). The cause is NOT always an old WebView — it can be a
// data-store/IndexedDB error or something else — so we surface the REAL cause
// from account.cryptoError, categorize it, and always show the raw error text.
// Presentation only: this does not change when the gate mounts or the
// crypto-init logic (see account.ts).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { accountManager } from "../core/manager";
import { categorizeCryptoError, type CryptoErrorCategory } from "./cryptoErrorCategory";

interface BrokenAccount {
  userId: string;
  error?: string;
}

/** Headline + guidance body per category. The raw error is rendered separately. */
function copyFor(category: CryptoErrorCategory): { title: string; body: ReactNode } {
  switch (category) {
    case "wasm":
      return {
        title: "Encryption unavailable",
        body: (
          <>
            <p style={pStyle}>
              Materix couldn't start its end-to-end encryption engine on this device. This looks
              like your <strong>Android System WebView is too old</strong> to run the encryption
              code.
            </p>
            <p style={pDimStyle}>
              Fix: update <strong>Android System WebView</strong> (or install an updated WebView such
              as Mulch/Bromite and pick it in Developer options → "WebView implementation"), then
              reopen Materix.
            </p>
          </>
        ),
      };
    case "datastore":
      return {
        title: "Encryption data-store problem",
        body: (
          <>
            <p style={pStyle}>
              Materix couldn't start end-to-end encryption because of a{" "}
              <strong>local data-store error</strong> — this is <strong>not</strong> a WebView
              problem.
            </p>
            <p style={pDimStyle}>
              Your encrypted data is preserved and has been left untouched. If a corrupted store was
              detected, you'll be offered a choice to <strong>Archive</strong> or <strong>Delete</strong>{" "}
              the affected store. You can also free up device storage and reopen Materix.
            </p>
          </>
        ),
      };
    default:
      return {
        title: "Encryption couldn't start",
        body: (
          <>
            <p style={pStyle}>
              Materix couldn't start its end-to-end encryption engine on this device. The exact
              cause is shown below.
            </p>
            <p style={pDimStyle}>
              You can continue without encryption for now; secure messaging and device verification
              will be unavailable until this is resolved.
            </p>
          </>
        ),
      };
  }
}

const pStyle: CSSProperties = {
  color: "var(--text-1, #e6e8ec)",
  fontSize: 15,
  lineHeight: 1.5,
};
const pDimStyle: CSSProperties = {
  color: "var(--text-2, #aab0bb)",
  fontSize: 14,
  lineHeight: 1.5,
};

export function CryptoGate() {
  // Acknowledge per broken user-id, not once for the whole session: an account
  // added later whose crypto fails is a NEWLY-broken id, so it must re-raise the
  // warning even after an earlier ack.
  const [acked, setAcked] = useState<string[]>([]);
  const [broken, setBroken] = useState<BrokenAccount[]>([]);

  const accountKeys = accountManager
    .list()
    .map((a) => a.key)
    .join(",");
  useEffect(() => {
    const check = () => {
      setBroken(
        accountManager
          .list()
          .map((a) => accountManager.account(a.key))
          .filter((acc) => acc.cryptoAvailable === false)
          .map((acc) => ({ userId: acc.session.userId, error: acc.cryptoError })),
      );
    };
    check();
    const unsubs = accountManager.list().map((a) => accountManager.account(a.key).events.on("self", check));
    // Crypto init runs during account start; re-check shortly after mount.
    const t = setTimeout(check, 3000);
    return () => {
      unsubs.forEach((u) => u());
      clearTimeout(t);
    };
    // Re-subscribe when the account set changes so a late account is covered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKeys]);

  const unacked = broken.filter((b) => !acked.includes(b.userId));
  if (unacked.length === 0) return null;

  // Drive the headline from the first not-yet-acknowledged account's real error;
  // the raw text for every affected account is shown in the detail block.
  const category = categorizeCryptoError(unacked[0].error);
  const { title, body } = copyFor(category);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        // NB: explicit sides, not `inset:0` — the `inset` shorthand is Chromium
        // 87+ and this gate must render on old WebViews (Chromium ~83).
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100000,
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
        <h2 style={{ margin: "12px 0 6px", color: "#ff6b6b" }}>{title}</h2>
        {body}
        <p style={{ color: "var(--text-2, #aab0bb)", fontSize: 13, lineHeight: 1.5 }}>
          Until then, this session <strong>cannot encrypt or decrypt secure messages and cannot
          verify devices</strong>.
        </p>
        {/* Always show the actual error(s) so the true cause is visible at a glance. */}
        <pre
          style={{
            textAlign: "left",
            margin: "12px 0 4px",
            padding: "10px 12px",
            background: "#0d0f14",
            border: "1px solid #2a2d36",
            borderRadius: 8,
            color: "#c7ccd6",
            fontSize: 12,
            lineHeight: 1.4,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {unacked
            .map((b) => `${b.userId}: ${b.error ?? "(no error detail)"}`)
            .join("\n")}
        </pre>
        <button
          onClick={() => setAcked((prev) => Array.from(new Set([...prev, ...unacked.map((b) => b.userId)])))}
          style={{
            marginTop: 14,
            padding: "11px 18px",
            width: "100%",
            border: "1px solid #7a2b2b",
            borderRadius: 10,
            background: "#3a1b1b",
            color: "#ffd9d9",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          I understand — continue without encryption
        </button>
      </div>
    </div>
  );
}
