// App shell: init, onboarding gate, three-pane layout, dialogs, notifications.

import { useEffect, useMemo, useRef, useState } from "react";
import { accountManager } from "./core/manager";
import type { SasFlow } from "./core/types";
import { useAccounts, useMediaQuery } from "./ui/hooks";
import { applyTheme } from "./ui/theme";
import { ToastProvider } from "./ui/components/Toast";
import { CryptoGate } from "./ui/CryptoGate";
import { Onboarding } from "./ui/Onboarding";
import { AccountRail, RoomListPane, type NewChatTab, type Selection } from "./ui/RoomList";
import { ChatPane } from "./ui/ChatPane";
import { DetailsPane } from "./ui/DetailsPane";
import { NewChatDialog } from "./ui/dialogs/NewChatDialog";
import { SettingsDialog } from "./ui/dialogs/SettingsDialog";
import { SecurityDialog } from "./ui/dialogs/SecurityDialog";
import { VerificationDialog } from "./ui/dialogs/VerificationDialog";
import { wireNotifications } from "./ui/notifications";
import { ensureAccountChannel } from "./ui/notifyChannels";
import { initPush } from "./ui/push";
import { NowPlaying } from "./ui/components/NowPlaying";
import { CallOverlay } from "./ui/components/CallOverlay";
import { PasscodeGate } from "./ui/passcodeGate";
import { getPrefs, setPref } from "./ui/prefs";
import { uiBus } from "./ui/bus";
import { initAndroidBack, setAppBackHandler } from "./ui/androidBack";

applyTheme();

type Dialog =
  | { kind: "none" }
  | { kind: "new-chat"; tab: NewChatTab }
  | { kind: "settings"; section?: "accounts" }
  | { kind: "add-account" }
  | { kind: "security"; accountKey: string };

export function App() {
  const [phase, setPhase] = useState<"loading" | "onboarding" | "ready">("loading");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activeFlow, setActiveFlow] = useState<SasFlow | null>(null);
  const narrow = useMediaQuery("(max-width: 760px)");
  useAccounts();

  // Accounts-bar visibility, shared by the rail and the room-list header.
  // An explicit user toggle is persisted; while unset the bar defaults to
  // "shown iff more than one account is signed in" (single-account users get
  // one bar, multi-account users see their accounts on startup).
  const [accountsBarPref, setAccountsBarPref] = useState<boolean | undefined>(
    () => getPrefs().ui?.accountsBar,
  );
  const showAccountsBar = accountsBarPref ?? accountManager.list().length > 1;
  const setShowAccountsBar = (shown: boolean) => {
    setAccountsBarPref(shown);
    setPref("ui", { ...getPrefs().ui, accountsBar: shown });
  };

  useEffect(() => {
    accountManager
      .init()
      .then(() => setPhase(accountManager.hasAccounts() ? "ready" : "onboarding"))
      .catch(() => setPhase("onboarding"));
  }, []);

  // Suppress the webview's default (browser) context menu so right-click feels
  // native — except on inputs and over selected text, where copy/paste is
  // useful. Custom onContextMenu handlers still open their own menus.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"]')) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // Android system Back: overlays are closed DOM-side (androidBack.ts); this
  // fallback covers app-level state — close the details panel, then leave the
  // open chat on the narrow layout. Returning false = nothing to go back
  // from: androidBack.ts backgrounds the app, Element-style (never exits).
  useEffect(() => {
    initAndroidBack();
    return setAppBackHandler(() => {
      if (detailsOpen) {
        setDetailsOpen(false);
        return true;
      }
      if (narrow && selection) {
        setSelection(null);
        return true;
      }
      return false;
    });
  }, [detailsOpen, narrow, selection]);

  // App-level command bus (open room / show verification flow from anywhere).
  useEffect(() => {
    const offs = [
      uiBus.register("openRoom", (sel) => {
        setSelection(sel);
        setDialog({ kind: "none" });
      }),
      uiBus.register("showFlow", (flow) => setActiveFlow(flow)),
    ];
    return () => offs.forEach((o) => o());
  }, []);

  // Notifications for every account; re-wire when the account set changes.
  // The selection lives in a ref so the notifier can ask "is this room open on
  // screen right now?" without re-wiring on every navigation.
  const selectionRef = useRef<Selection | null>(null);
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  const accountKeys = accountManager
    .list()
    .map((a) => a.key)
    .join(",");
  useEffect(() => {
    // Background push (Android/UnifiedPush): (re)assert distributor registration
    // and register the Matrix pusher for every account. No-op off Android.
    initPush();
    const unsubs = accountManager.list().map((a) => {
      const account = accountManager.account(a.key);
      if (!account.client) return () => undefined;
      // Android: give each account its own notification channel up front so
      // the user can assign it a sound in the OS notification settings.
      void ensureAccountChannel(a.key, a.userId);
      return wireNotifications(
        account.client,
        a.key,
        (roomId) => setSelection({ accountKey: a.key, roomId }),
        (roomId) => account.isMuted(roomId),
        (roomId) =>
          selectionRef.current?.accountKey === a.key && selectionRef.current?.roomId === roomId,
      );
    });
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKeys, phase]);

  // Surface incoming verification requests from any account. A request the
  // user has already dismissed must not re-open from a lingering flow.
  const dismissedFlows = useRef(new Set<string>());
  useEffect(() => {
    if (phase !== "ready") return;
    const unsubs = accountManager.list().map((a) => {
      const account = accountManager.account(a.key);
      const surface = () => {
        const flow = account.crypto
          .activeFlows()
          .find(
            (f) =>
              !f.initiatedByMe &&
              !dismissedFlows.current.has(f.flowId) &&
              (f.phase === "requested" || f.phase === "ready" || f.phase === "emojis"),
          );
        if (flow) setActiveFlow((cur) => cur ?? flow);
      };
      surface(); // pick up requests that arrived before this subscription
      return account.crypto.events.on("flows", surface);
    });
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKeys, phase]);

  // Refresh verification dialog phase changes.
  const flowAccount = useMemo(
    () => (activeFlow ? accountManager.tryAccount(activeFlow.accountKey) : null),
    [activeFlow],
  );
  const [, setFlowTick] = useState(0);
  useEffect(() => {
    if (!flowAccount) return;
    return flowAccount.crypto.events.on("flows", () => setFlowTick((n) => n + 1));
  }, [flowAccount]);

  if (phase === "loading") {
    return (
      <div className="app-loading">
        <span className="spinner" />
        <span>Opening Materix…</span>
        <PasscodeGate />
      </div>
    );
  }

  if (phase === "onboarding") {
    return (
      <ToastProvider>
        <Onboarding onDone={() => setPhase("ready")} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className={`app${narrow && selection ? " mobile-chat" : ""}`}>
        {showAccountsBar && (
          <AccountRail
            onAddAccount={() => setDialog({ kind: "add-account" })}
            onSettings={() => setDialog({ kind: "settings" })}
            onHide={() => setShowAccountsBar(false)}
          />
        )}
        <RoomListPane
          selection={selection}
          onSelect={(sel) => {
            setSelection(sel);
            setDetailsOpen(false);
          }}
          onNewChat={(tab) => setDialog({ kind: "new-chat", tab })}
          onOpenSecurity={(accountKey) => setDialog({ kind: "security", accountKey })}
          onAddAccount={() => setDialog({ kind: "add-account" })}
          onSettings={() => setDialog({ kind: "settings" })}
          onManageAccount={() => setDialog({ kind: "settings", section: "accounts" })}
          accountsBarShown={showAccountsBar}
          onToggleAccountsBar={() => setShowAccountsBar(!showAccountsBar)}
        />
        <ChatPane
          selection={selection}
          onBack={() => setSelection(null)}
          onToggleDetails={() => setDetailsOpen((v) => !v)}
        />
        {detailsOpen && selection && (
          <DetailsPane
            selection={selection}
            onClose={() => setDetailsOpen(false)}
            onLeft={() => {
              setDetailsOpen(false);
              setSelection(null);
            }}
          />
        )}
      </div>

      <NowPlaying />
      <CallOverlay />
      <PasscodeGate />
      <CryptoGate />

      {dialog.kind === "new-chat" && (
        <NewChatDialog
          onClose={() => setDialog({ kind: "none" })}
          onOpenRoom={setSelection}
          initialTab={dialog.tab}
        />
      )}
      {dialog.kind === "security" && accountManager.tryAccount(dialog.accountKey) && (
        <SecurityDialog
          account={accountManager.account(dialog.accountKey)}
          onClose={() => setDialog({ kind: "none" })}
        />
      )}
      {dialog.kind === "settings" && (
        <SettingsDialog
          onClose={() => setDialog({ kind: "none" })}
          onAddAccount={() => setDialog({ kind: "add-account" })}
          onStartVerification={(flow) => setActiveFlow(flow)}
          initialSection={dialog.section}
        />
      )}
      {dialog.kind === "add-account" && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDialog({ kind: "none" });
          }}
        >
          <Onboarding
            embedded
            onDone={() => setDialog({ kind: "none" })}
            onCancel={() => setDialog({ kind: "none" })}
          />
        </div>
      )}
      {activeFlow && (
        <VerificationDialog
          flow={activeFlow}
          onClose={() => {
            dismissedFlows.current.add(activeFlow.flowId);
            setActiveFlow(null);
          }}
        />
      )}
    </ToastProvider>
  );
}
