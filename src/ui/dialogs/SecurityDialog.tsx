// Security setup / recovery for one account. Reached from the first-run
// banner and from Settings. Three situations:
//  - needs-setup:  bootstrap cross-signing + secret storage + key backup
//  - needs-verify: verify this session (another device or recovery key)
//  - ok:           show status
import { useEffect, useState } from "react";
import type { MatrixAccount } from "../../core/account";
import { Modal } from "../components/Modal";
import { IconDownload, IconFile, IconKey, IconShieldCheck } from "../components/Icons";
import { useToast } from "../components/Toast";
import { copyText } from "../clipboard";
import { uiBus } from "../bus";

export function SecurityDialog({ account, onClose }: { account: MatrixAccount; onClose: () => void }) {
  const [state, setState] = useState<"loading" | "needs-setup" | "needs-verify" | "ok" | "unavailable">("loading");
  const [password, setPassword] = useState("");
  const [recoveryKeyOut, setRecoveryKeyOut] = useState("");
  const [recoveryKeyIn, setRecoveryKeyIn] = useState("");
  const [busy, setBusy] = useState(false);
  const { show, showError } = useToast();

  const refresh = () => {
    account.crypto.securityState().then(setState).catch(() => setState("unavailable"));
  };
  useEffect(() => {
    refresh();
    return account.crypto.events.on("status", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  return (
    <Modal title="Secure messaging" onClose={onClose}>
      {state === "loading" && (
        <div className="empty-state" style={{ padding: "var(--sp-4)" }}>
          <span className="spinner" />
        </div>
      )}

      {state === "unavailable" && <p>Encryption isn't available for this account right now.</p>}

      {state === "needs-setup" && !recoveryKeyOut && (
        <>
          <p>
            Set up <strong>secure backup</strong> so you can read encrypted messages on new devices and never lose
            them. You'll get a recovery key — keep it somewhere safe.
          </p>
          <div className="field">
            <label htmlFor="sec-pw">Account password</label>
            <input
              id="sec-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
            <div className="field-hint">Needed once to publish your signing keys.</div>
          </div>
          <button
            className="btn primary"
            disabled={busy || !password}
            onClick={async () => {
              setBusy(true);
              try {
                setRecoveryKeyOut(await account.crypto.setupSecurity(password));
                setPassword("");
              } catch (e) {
                showError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : "Set up secure backup"}
          </button>
        </>
      )}

      {recoveryKeyOut && (
        <>
          <p>
            <strong>Your recovery key.</strong> Save it in a password manager or write it down — it is shown only
            once and is the only way to restore your messages if you lose all devices.
          </p>
          <div className="recovery-key-box">{recoveryKeyOut}</div>
          <div style={{ display: "flex", gap: "var(--sp-2)" }}>
            <button
              className="btn secondary"
              onClick={() => copyText(recoveryKeyOut).then(() => show("Copied."), showError)}
            >
              Copy
            </button>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              onClick={() => {
                setRecoveryKeyOut("");
                refresh();
                show("Secure backup is ready.");
                onClose();
              }}
            >
              I saved my recovery key
            </button>
          </div>
        </>
      )}

      {state === "needs-verify" && !recoveryKeyOut && (
        <>
          <p>
            Verify this session to access your encrypted message history and let others trust this device.
          </p>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              try {
                const flow = await account.crypto.startOwnVerification();
                uiBus.showFlow(flow);
                onClose();
              } catch (e) {
                showError(e);
              }
            }}
          >
            <IconShieldCheck size={16} /> Verify with another device
          </button>
          <div className="field">
            <label htmlFor="sec-rk">Or enter your recovery key</label>
            <input
              id="sec-rk"
              value={recoveryKeyIn}
              onChange={(e) => setRecoveryKeyIn(e.target.value)}
              placeholder="EsT2 ..."
              spellCheck={false}
            />
          </div>
          <button
            className="btn secondary"
            disabled={busy || !recoveryKeyIn.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const { imported } = await account.crypto.restoreWithRecoveryKey(recoveryKeyIn);
                show(`Session verified. Restored ${imported} message keys.`);
                setRecoveryKeyIn("");
                refresh();
                onClose();
              } catch (e) {
                showError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <span className="spinner" /> : <IconKey size={16} />} Restore with recovery key
          </button>
        </>
      )}

      {state === "ok" && (
        <>
          <p style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <IconShieldCheck size={18} /> This session is verified and key backup is connected.
          </p>
          <KeyExportSection account={account} />
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </>
      )}
    </Modal>
  );
}

/**
 * Manual room-key backup: export every key this session holds into a
 * passphrase-encrypted file (the Element-compatible MEGOLM SESSION DATA
 * format), or import such a file. Used for offline backups and for moving
 * encrypted history to another client without the server-side key backup.
 */
function KeyExportSection({ account }: { account: MatrixAccount }) {
  const { show, showError } = useToast();
  const [mode, setMode] = useState<null | "export" | "import">(null);
  const [exportPw, setExportPw] = useState("");
  const [importPw, setImportPw] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode(null);
    setExportPw("");
    setImportPw("");
    setFile(null);
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const text = await account.crypto.exportRoomKeys(exportPw);
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `materix-keys-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      show("Encryption keys exported.");
      reset();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const { imported, total } = await account.crypto.importRoomKeys(text, importPw);
      show(`Imported ${imported} of ${total} message keys.`);
      reset();
    } catch (e) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="key-export">
      <div className="key-export-head">
        <IconKey size={16} />
        <div>
          <div className="key-export-title">Encryption keys</div>
          <div className="key-export-sub">
            Save a passphrase-protected copy of your encrypted history, or restore one, to back it up or move it
            between devices.
          </div>
        </div>
      </div>

      {mode === null && (
        <div className="key-export-actions">
          <button className="btn secondary" onClick={() => setMode("export")}>
            <IconDownload size={16} /> Export keys
          </button>
          <button className="btn secondary" onClick={() => setMode("import")}>
            <IconFile size={16} /> Import keys
          </button>
        </div>
      )}

      {mode === "export" && (
        <div className="key-export-form">
          <div className="field">
            <label htmlFor="kx-export-pw">Passphrase</label>
            <input
              id="kx-export-pw"
              type="password"
              value={exportPw}
              onChange={(e) => setExportPw(e.target.value)}
              autoComplete="new-password"
            />
            <div className="field-hint">You will need this passphrase to import the file later.</div>
          </div>
          <div className="key-export-form-actions">
            <button className="btn ghost" disabled={busy} onClick={reset}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !exportPw} onClick={doExport}>
              {busy ? <span className="spinner" /> : "Download key file"}
            </button>
          </div>
        </div>
      )}

      {mode === "import" && (
        <div className="key-export-form">
          <div className="field">
            <label htmlFor="kx-import-file">Key file</label>
            <input
              id="kx-import-file"
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="field">
            <label htmlFor="kx-import-pw">Passphrase</label>
            <input
              id="kx-import-pw"
              type="password"
              value={importPw}
              onChange={(e) => setImportPw(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="key-export-form-actions">
            <button className="btn ghost" disabled={busy} onClick={reset}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !file || !importPw} onClick={doImport}>
              {busy ? <span className="spinner" /> : "Import keys"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
