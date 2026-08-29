// Left column: account rail + unified room list across all accounts.

import { useEffect, useMemo, useState } from "react";
import { accountManager } from "../core/manager";
import type { RoomSummary, SpaceSummary } from "../core/types";
import { useAccounts, useClock, useRoomsVersion } from "./hooks";
import { Avatar } from "./components/Avatar";
import { ContextMenu, type MenuState } from "./components/ContextMenu";
import { IconChat, IconChevronLeft, IconChevronRight, IconGlobe, IconHash, IconLock, IconMuted, IconPlus, IconSearch, IconSettings, IconShield } from "./components/Icons";
import { formatListTime, typingText } from "./format";
import { copyText } from "./clipboard";
import { useToast } from "./components/Toast";

export interface Selection {
  accountKey: string;
  roomId: string;
}

export type NewChatTab = "dm" | "group" | "join" | "explore";

/** Which space filters the unified room list. */
type SpaceFilter =
  | { kind: "all" }
  | { kind: "home" }
  | { kind: "space"; accountKey: string; roomId: string };

const HOUR = 3_600_000;
const MUTE_PRESETS: [string, number][] = [
  ["For 1 hour", HOUR],
  ["For 8 hours", 8 * HOUR],
  ["Until tomorrow", 24 * HOUR],
  ["For 1 week", 7 * 24 * HOUR],
  ["Until I turn it back on", Infinity],
];

export function AccountRail({
  onAddAccount,
  onSettings,
  onHide,
}: {
  onAddAccount: () => void;
  onSettings: () => void;
  onHide: () => void;
}) {
  useAccounts();
  useRoomsVersion();
  const accounts = accountManager.list();
  const active = accountManager.active;

  return (
    <nav className={`rail${accounts.length > 1 ? " multi" : ""}`} aria-label="Accounts">
      {/* « — collapses the bar; its » twin then appears in the room-list
          header (see RoomListPane), so one chevron is always visible. */}
      <button className="rail-btn" onClick={onHide} title="Hide accounts bar" aria-label="Hide accounts bar">
        <IconChevronLeft />
      </button>
      <div className="rail-accounts">
        {accounts.map((a) => {
          const unread = accountManager
            .account(a.key)
            .rooms()
            .reduce((n, r) => n + r.unreadCount + (r.isInvite ? 1 : 0), 0);
          return (
            <button
              key={a.key}
              className={`rail-btn${a.key === active ? " active" : ""}`}
              style={{ ["--account-color" as string]: a.color }}
              // Clicking the already-active account opens Settings (instead of
              // a no-op re-activation); other accounts switch as before.
              onClick={() => (a.key === active ? onSettings() : accountManager.setActive(a.key))}
              title={`${a.userId}${a.key === active ? " — settings" : ""}${a.syncState === "error" ? " — connection trouble" : ""}`}
              aria-label={a.key === active ? `Account ${a.userId} — open settings` : `Switch to account ${a.userId}`}
              aria-current={a.key === active}
            >
              <Avatar account={accountManager.account(a.key)} mxc={a.avatarUrl} name={a.displayName} id={a.userId} size={38} />
              {unread > 0 && <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>}
              {a.syncState === "error" && <span className="rail-sync-error" />}
            </button>
          );
        })}
        <button className="rail-btn" onClick={onAddAccount} title="Add account" aria-label="Add account">
          <IconPlus />
        </button>
      </div>
      <button className="rail-btn" onClick={onSettings} title="Settings" aria-label="Settings">
        <IconSettings />
      </button>
    </nav>
  );
}

export function RoomListPane({
  selection,
  onSelect,
  onNewChat,
  onOpenSecurity,
  onAddAccount,
  onSettings,
  onManageAccount,
  accountsBarShown,
  onToggleAccountsBar,
}: {
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  onNewChat: (tab: NewChatTab) => void;
  onOpenSecurity: (accountKey: string) => void;
  onAddAccount: () => void;
  onSettings: () => void;
  onManageAccount: () => void;
  accountsBarShown: boolean;
  onToggleAccountsBar: () => void;
}) {
  useRoomsVersion();
  useAccounts();
  const now = useClock(30_000);
  const [filter, setFilter] = useState("");
  const [space, setSpace] = useState<SpaceFilter>({ kind: "all" });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Chats (direct) / Rooms (everything else) are independent show/hide toggles
  // rendered in the header in every orientation; both default on.
  const [showChats, setShowChats] = useState(true);
  const [showRooms, setShowRooms] = useState(true);
  const { showError, show } = useToast();

  const accounts = accountManager.list();
  const multiAccount = accounts.length > 1;
  const activeMeta = accounts.find((a) => a.key === accountManager.active) ?? accounts[0];

  const allRooms = useMemo(() => {
    const rooms: RoomSummary[] = [];
    for (const a of accounts) {
      try {
        rooms.push(...accountManager.account(a.key).rooms());
      } catch {
        // account may be mid-teardown
      }
    }
    return rooms;
  }, [accounts, accountManager.events.version("rooms")]); // eslint-disable-line react-hooks/exhaustive-deps

  const spaces = useMemo(() => {
    const list: SpaceSummary[] = [];
    for (const a of accounts) {
      try {
        list.push(...accountManager.account(a.key).spaces());
      } catch {
        // account may be mid-teardown
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [accounts, accountManager.events.version("rooms")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop back to "All" if the selected space is gone (left / account removed).
  useEffect(() => {
    if (
      space.kind === "space" &&
      !spaces.some((s) => s.accountKey === space.accountKey && s.roomId === space.roomId)
    ) {
      setSpace({ kind: "all" });
    }
  }, [space, spaces]);

  // Room ids that pass the active space filter. `null` = no filter (All).
  const spaceMembership = useMemo(() => {
    if (space.kind === "all") return null;
    if (space.kind === "space") {
      const acc = accountManager.tryAccount(space.accountKey);
      const ids = acc ? acc.spaceChildRoomIds(space.roomId) : new Set<string>();
      return (r: RoomSummary) => r.accountKey === space.accountKey && ids.has(r.roomId);
    }
    // Home: rooms in no space of their own account.
    const byAccount = new Map<string, Set<string>>();
    for (const a of accounts) {
      const acc = accountManager.tryAccount(a.key);
      if (!acc) continue;
      const union = new Set<string>();
      for (const s of acc.spaces()) for (const id of acc.spaceChildRoomIds(s.roomId)) union.add(id);
      byAccount.set(a.key, union);
    }
    return (r: RoomSummary) => !byAccount.get(r.accountKey)?.has(r.roomId);
  }, [space, accounts, accountManager.events.version("rooms")]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = filter.trim().toLowerCase();
  const visible = allRooms.filter((r) => !r.isSpace && (!q || r.name.toLowerCase().includes(q)));
  // The list splits into Chats (direct) / Rooms (everything else); each half
  // is visible only while its header toggle is on.
  const inSection = (r: RoomSummary) => (r.isDirect ? showChats : showRooms);
  // Invitations stay visible regardless of space/section; chats are filtered.
  const inSpace = visible.filter(
    (r) => r.isInvite || ((!spaceMembership || spaceMembership(r)) && inSection(r)),
  );

  const invites = inSpace.filter((r) => r.isInvite);
  const archived = inSpace
    .filter((r) => !r.isInvite && r.isArchived)
    .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  const chats = inSpace
    .filter((r) => !r.isInvite && !r.isLowPriority && !r.isArchived)
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.lastActivityTs - a.lastActivityTs);
  const lowPriority = inSpace
    .filter((r) => !r.isInvite && r.isLowPriority && !r.isArchived)
    .sort((a, b) => b.lastActivityTs - a.lastActivityTs);

  const colorOf = (key: string) => accounts.find((a) => a.key === key)?.color ?? "gray";

  const anyUnread = allRooms.some((r) => !r.isInvite && !r.isSpace && (r.unreadCount > 0 || r.markedUnread));
  // Per-toggle unread badges: messages + pending invites, split like the rail
  // badge but by direct (Chats) vs everything else (Rooms).
  const unreadIn = (direct: boolean) =>
    allRooms
      .filter((r) => !r.isSpace && r.isDirect === direct)
      .reduce((n, r) => n + r.unreadCount + (r.isInvite ? 1 : 0), 0);
  const chatsUnread = unreadIn(true);
  const roomsUnread = unreadIn(false);
  const markAllRead = async () => {
    const results = await Promise.allSettled(accounts.map((a) => accountManager.tryAccount(a.key)?.markAllRead()));
    const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) showError(failed.reason);
    else show("Marked all as read.");
  };

  return (
    <div className="rooms-pane">
      <div className="rooms-header">
        {/* » — persistent affordance to bring the accounts bar back; while the
            bar is shown its own « (AccountRail) hides it instead. */}
        {!accountsBarShown && (
          <button
            className="icon-btn"
            onClick={onToggleAccountsBar}
            title="Show accounts bar"
            aria-label="Show accounts bar"
          >
            <IconChevronRight size={20} />
          </button>
        )}
        {activeMeta && (
          <button
            className="header-avatar-btn"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({
                x: r.left,
                y: r.bottom + 4,
                items: [
                  { label: "Manage account", onClick: onManageAccount },
                  { label: "Add account", onClick: onAddAccount },
                  {
                    label: accountsBarShown ? "Hide accounts bar" : "Show accounts bar",
                    onClick: onToggleAccountsBar,
                  },
                  { label: "Settings", onClick: onSettings },
                  {
                    label: "Logout",
                    danger: true,
                    onClick: async () => {
                      if (
                        !confirm(
                          `Sign out ${activeMeta.userId}? Encrypted history on this device will be removed.`,
                        )
                      )
                        return;
                      try {
                        await accountManager.logout(activeMeta.key);
                        show("Signed out.");
                      } catch (e) {
                        showError(e);
                      }
                    },
                  },
                ],
              });
            }}
            title={`${activeMeta.userId} — account menu`}
            aria-label={`Account menu for ${activeMeta.userId}`}
            aria-haspopup="menu"
          >
            <Avatar
              account={accountManager.tryAccount(activeMeta.key)}
              mxc={activeMeta.avatarUrl}
              name={activeMeta.displayName}
              id={activeMeta.userId}
              size={28}
            />
          </button>
        )}
        <div className="section-tabs" aria-label="Sections">
          <button
            className={`section-tab${showChats ? " active" : ""}`}
            aria-pressed={showChats}
            onClick={() => setShowChats((v) => !v)}
            title={showChats ? "Hide chats" : "Show chats"}
            aria-label={`${showChats ? "Hide" : "Show"} chats${chatsUnread > 0 ? ` (${chatsUnread} unread)` : ""}`}
          >
            <IconChat size={20} />
            {chatsUnread > 0 && <span className="section-badge">{chatsUnread > 99 ? "99+" : chatsUnread}</span>}
          </button>
          <button
            className={`section-tab${showRooms ? " active" : ""}`}
            aria-pressed={showRooms}
            onClick={() => setShowRooms((v) => !v)}
            title={showRooms ? "Hide rooms" : "Show rooms"}
            aria-label={`${showRooms ? "Hide" : "Show"} rooms${roomsUnread > 0 ? ` (${roomsUnread} unread)` : ""}`}
          >
            <IconHash size={20} />
            {roomsUnread > 0 && <span className="section-badge">{roomsUnread > 99 ? "99+" : roomsUnread}</span>}
          </button>
        </div>
        <button
          className="icon-btn"
          onClick={() => onNewChat("explore")}
          title="Explore public rooms"
          aria-label="Explore public rooms"
        >
          <IconGlobe size={20} />
        </button>
        <button
          className="icon-btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: r.left,
              y: r.bottom + 4,
              items: [
                { label: "New direct message", onClick: () => onNewChat("dm") },
                { label: "New group", onClick: () => onNewChat("group") },
                { label: "Join a room", onClick: () => onNewChat("join") },
                { label: "Explore public rooms", onClick: () => onNewChat("explore") },
              ],
            });
          }}
          title="New chat"
          aria-label="New chat"
          aria-haspopup="menu"
        >
          <IconPlus size={20} />
        </button>
        {/* No standalone "Join a room" (IconEnter) button: its door-and-arrow
            glyph reads as a logout icon in the bar. Join lives in the + menu. */}
        <button className="icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
          <IconSettings size={20} />
        </button>
      </div>
      <SecurityBanner onOpenSecurity={onOpenSecurity} />
      <div className="search-box">
        <IconSearch size={16} />
        <input
          type="search"
          placeholder="Search chats"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Search chats"
        />
      </div>
      {spaces.length > 0 && (
        <div className="space-strip" role="tablist" aria-label="Spaces">
          <button
            className={`space-chip${space.kind === "all" ? " active" : ""}`}
            role="tab"
            aria-selected={space.kind === "all"}
            onClick={() => setSpace({ kind: "all" })}
          >
            All
          </button>
          <button
            className={`space-chip${space.kind === "home" ? " active" : ""}`}
            role="tab"
            aria-selected={space.kind === "home"}
            onClick={() => setSpace({ kind: "home" })}
          >
            Home
          </button>
          {spaces.map((s) => {
            const active =
              space.kind === "space" && space.accountKey === s.accountKey && space.roomId === s.roomId;
            return (
              <button
                key={s.accountKey + s.roomId}
                className={`space-chip space${active ? " active" : ""}`}
                role="tab"
                aria-selected={active}
                title={s.name}
                onClick={() => setSpace({ kind: "space", accountKey: s.accountKey, roomId: s.roomId })}
              >
                <Avatar
                  account={accountManager.tryAccount(s.accountKey)}
                  mxc={s.avatarUrl}
                  name={s.name}
                  id={s.roomId}
                  size={22}
                />
                <span className="space-chip-name">{s.name}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="rooms-scroll">
        {anyUnread && (
          <button className="mark-all-read" onClick={markAllRead}>
            Mark all as read
          </button>
        )}
        {invites.length > 0 && (
          <div className="rooms-section">
            <div className="rooms-section-title">Invitations</div>
            {invites.map((r) => (
              <div key={r.accountKey + r.roomId} className="invite-card">
                <div className="invite-card-head">
                  <Avatar account={accountManager.account(r.accountKey)} mxc={r.avatarUrl} name={r.name} id={r.roomId} size={36} />
                  <div className="room-item-main">
                    <span className="room-item-name">{r.name}</span>
                    <span className="room-item-preview">
                      {r.inviterName ? `Invited by ${r.inviterName}` : "You've been invited"}
                    </span>
                  </div>
                </div>
                <div className="invite-actions">
                  <button
                    className="btn primary small"
                    onClick={async () => {
                      try {
                        await accountManager.account(r.accountKey).acceptInvite(r.roomId);
                        onSelect({ accountKey: r.accountKey, roomId: r.roomId });
                      } catch (e) {
                        showError(e);
                      }
                    }}
                  >
                    Accept
                  </button>
                  <button
                    className="btn secondary small"
                    onClick={async () => {
                      try {
                        await accountManager.account(r.accountKey).rejectInvite(r.roomId);
                        show("Invitation declined.");
                      } catch (e) {
                        showError(e);
                      }
                    }}
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <RoomSection
          title={q ? `Results (${chats.length})` : undefined}
          rooms={chats}
          selection={selection}
          onSelect={onSelect}
          onMenu={setMenu}
          now={now}
          multiAccount={multiAccount}
          colorOf={colorOf}
        />
        {lowPriority.length > 0 && (
          <RoomSection
            title="Low priority"
            rooms={lowPriority}
            selection={selection}
            onSelect={onSelect}
            onMenu={setMenu}
            now={now}
            multiAccount={multiAccount}
            colorOf={colorOf}
          />
        )}
        {archived.length > 0 && (
          <div className="rooms-section">
            <button
              className="rooms-section-title"
              style={{ display: "flex", width: "100%", gap: 6, alignItems: "center", cursor: "pointer" }}
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
            >
              {showArchived ? "▾" : "▸"} Archived ({archived.length})
            </button>
            {showArchived && (
              <RoomSection
                rooms={archived}
                selection={selection}
                onSelect={onSelect}
                onMenu={setMenu}
                now={now}
                multiAccount={multiAccount}
                colorOf={colorOf}
              />
            )}
          </div>
        )}

        {inSpace.length === 0 && (
          <div className="empty-state" style={{ padding: "var(--sp-5)" }}>
            <div className="empty-glyph">
              <IconChat size={30} />
            </div>
            {q ? (
              <p>No chats match "{filter}".</p>
            ) : space.kind !== "all" ? (
              <p>No chats in this space yet.</p>
            ) : !showChats && !showRooms ? (
              <>
                <h2 style={{ fontSize: "var(--fs-lg)" }}>Everything is hidden</h2>
                <p>Turn the Chats or Rooms filter back on above.</p>
              </>
            ) : showRooms && !showChats ? (
              <>
                <h2 style={{ fontSize: "var(--fs-lg)" }}>No rooms yet</h2>
                <p>Join or create a room to get going.</p>
                <button className="btn primary" onClick={() => onNewChat("join")}>
                  Join a room
                </button>
              </>
            ) : showChats && !showRooms && visible.some((r) => !r.isDirect && !r.isInvite) ? (
              <>
                <h2 style={{ fontSize: "var(--fs-lg)" }}>No direct chats yet</h2>
                <p>Your group conversations are behind the Rooms filter.</p>
                <button className="btn primary" onClick={() => onNewChat("dm")}>
                  Start a chat
                </button>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: "var(--fs-lg)" }}>No chats yet</h2>
                <p>Start a conversation or join a room to get going.</p>
                <button className="btn primary" onClick={() => onNewChat("dm")}>
                  Start a chat
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** First-run E2EE nudge for the active account: set up backup / verify session. */
function SecurityBanner({ onOpenSecurity }: { onOpenSecurity: (accountKey: string) => void }) {
  useAccounts();
  const activeKey = accountManager.active;
  const account = accountManager.tryAccount(activeKey);
  const [state, setState] = useState<"needs-setup" | "needs-verify" | "ok" | "unavailable" | "loading">("loading");
  const [dismissed, setDismissed] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("materix.securityDismissed") ?? "[]"),
  );

  useEffect(() => {
    if (!account) return;
    let alive = true;
    const check = () => {
      account.crypto.securityState().then((s) => {
        if (alive) setState(s);
      });
    };
    check();
    const offStatus = account.crypto.events.on("status", check);
    // Sync state affects crypto readiness; re-check once shortly after mount.
    const t = setTimeout(check, 5000);
    return () => {
      alive = false;
      offStatus();
      clearTimeout(t);
    };
  }, [account]);

  if (!account || !activeKey) return null;
  if (state !== "needs-setup" && state !== "needs-verify") return null;
  if (dismissed.includes(activeKey)) return null;

  return (
    <div className="security-banner">
      <IconShield size={22} />
      <span className="banner-text">
        <strong>{state === "needs-setup" ? "Set up secure backup" : "Verify this session"}</strong>
        {state === "needs-setup"
          ? "Keep your encrypted messages safe on every device."
          : "Access your encrypted history on this device."}
      </span>
      <span className="banner-actions">
        <button className="btn primary small" onClick={() => onOpenSecurity(activeKey)}>
          {state === "needs-setup" ? "Set up" : "Verify"}
        </button>
        <button
          className="icon-btn"
          style={{ width: 26, height: 26 }}
          aria-label="Dismiss"
          title="Dismiss"
          onClick={() => {
            const next = [...dismissed, activeKey];
            setDismissed(next);
            localStorage.setItem("materix.securityDismissed", JSON.stringify(next));
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

function RoomSection({
  title,
  rooms,
  selection,
  onSelect,
  onMenu,
  now,
  multiAccount,
  colorOf,
}: {
  title?: string;
  rooms: RoomSummary[];
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  onMenu: (menu: MenuState) => void;
  now: number;
  multiAccount: boolean;
  colorOf: (key: string) => string;
}) {
  const { show, showError } = useToast();
  if (rooms.length === 0) return null;

  const openMenu = (e: React.MouseEvent, r: RoomSummary) => {
    e.preventDefault();
    const account = accountManager.tryAccount(r.accountKey);
    if (!account) return;
    onMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        r.unreadCount > 0 || r.markedUnread
          ? {
              label: "Mark as read",
              onClick: () => account.room(r.roomId).markRead().catch(showError),
            }
          : {
              label: "Mark as unread",
              onClick: () => account.room(r.roomId).markUnread(true).catch(showError),
            },
        {
          label: r.mutedUntil ? "Unmute" : "Mute notifications…",
          onClick: () => {
            if (r.mutedUntil) {
              account.setMuted(r.roomId, undefined).catch(showError);
            } else {
              onMenu({
                x: e.clientX,
                y: e.clientY,
                items: MUTE_PRESETS.map(([label, ms]) => ({
                  label,
                  onClick: () => account.setMuted(r.roomId, ms).then(() => show(`Muted ${label.toLowerCase()}.`)).catch(showError),
                })),
              });
            }
          },
        },
        {
          label: r.isFavorite ? "Remove from favorites" : "Add to favorites",
          onClick: () => account.setRoomTag(r.roomId, "m.favourite", !r.isFavorite).catch(showError),
        },
        {
          label: r.isArchived ? "Unarchive" : "Archive",
          onClick: () => account.setArchived(r.roomId, !r.isArchived).catch(showError),
        },
        {
          label: r.isLowPriority ? "Restore priority" : "Mark low priority",
          onClick: () => account.setRoomTag(r.roomId, "m.lowpriority", !r.isLowPriority).catch(showError),
        },
        {
          label: "Copy room address",
          onClick: () => copyText(r.roomId).then(() => show("Copied."), showError),
        },
        {
          label: "Leave",
          danger: true,
          onClick: () => {
            if (confirm(`Leave "${r.name}"?`)) account.room(r.roomId).leave().catch(showError);
          },
        },
      ],
    });
  };
  return (
    <div className="rooms-section">
      {title && <div className="rooms-section-title">{title}</div>}
      {rooms.map((r) => {
        const selected = selection?.accountKey === r.accountKey && selection?.roomId === r.roomId;
        const typing = typingText(r.typing);
        return (
          <button
            key={r.accountKey + r.roomId}
            className={`room-item${selected ? " selected" : ""}${r.unreadCount > 0 || r.markedUnread ? " unread" : ""}`}
            onClick={() => onSelect({ accountKey: r.accountKey, roomId: r.roomId })}
            onContextMenu={(e) => openMenu(e, r)}
            aria-current={selected}
          >
            <Avatar
              account={accountManager.tryAccount(r.accountKey)}
              mxc={r.avatarUrl}
              name={r.name}
              id={r.roomId}
              size={44}
            />
            <div className="room-item-main">
              <div className="room-item-top">
                {multiAccount && (
                  <span className="account-dot" style={{ background: colorOf(r.accountKey) }} title="Account" />
                )}
                <span className="room-item-name">{r.name}</span>
                {r.isEncrypted && (
                  <span className="enc-lock" title="End-to-end encrypted">
                    <IconLock size={12} />
                  </span>
                )}
                {r.mutedUntil > 0 && (
                  <span className="enc-lock" title="Muted" aria-label="Muted">
                    <IconMuted size={12} />
                  </span>
                )}
                {r.lastEvent && <span className="room-item-time">{formatListTime(r.lastEvent.ts, now)}</span>}
              </div>
              <div className="room-item-bottom">
                <span className={`room-item-preview${typing ? " typing" : ""}`}>
                  {typing ||
                    (r.lastEvent ? `${r.isDirect ? "" : r.lastEvent.senderName + ": "}${r.lastEvent.preview}` : "No messages yet")}
                </span>
                {r.unreadCount > 0 ? (
                  <span className={`unread-pill${r.highlightCount > 0 && !r.mutedUntil ? " highlight" : ""}${r.mutedUntil ? " muted" : ""}`}>
                    {r.unreadCount > 99 ? "99+" : r.unreadCount}
                  </span>
                ) : r.markedUnread ? (
                  <span className={`unread-pill dot${r.mutedUntil ? " muted" : ""}`} aria-label="Unread" />
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
