// Middle column: header + timeline + typing + composer for the selected room.

import { useMemo, useRef, useState } from "react";
import { accountManager } from "../core/manager";
import type { RoomHandle } from "../core/roomHandle";
import type { SearchHit, TimelineItem } from "../core/types";
import { MaterixError } from "../core/errors";
import { useRoomVersion, useRoomsVersion } from "./hooks";
import type { Selection } from "./RoomList";
import { Timeline } from "./Timeline";
import { ThreadView } from "./ThreadView";
import { ThreadsPanel } from "./ThreadsPanel";
import { Composer, type ComposeMode } from "./Composer";
import { Avatar } from "./components/Avatar";
import {
  IconBack,
  IconChat,
  IconChevronDown,
  IconChevronUp,
  IconInfo,
  IconLock,
  IconPaperclip,
  IconPhone,
  IconPin,
  IconSearch,
  IconSettings,
  IconThreads,
  IconVideo,
  IconX,
} from "./components/Icons";
import { RoomSettingsDialog } from "./dialogs/RoomSettingsDialog";
import { formatListTime, formatTime, typingText } from "./format";
import { useToast } from "./components/Toast";
import { useEffect } from "react";
import { LiveBeacons } from "./LiveBeacons";

export function ChatPane({
  selection,
  onBack,
  onToggleDetails,
}: {
  selection: Selection | null;
  onBack: () => void;
  onToggleDetails: () => void;
}) {
  useRoomsVersion();
  const account = accountManager.tryAccount(selection?.accountKey ?? null);
  useRoomVersion(account, selection?.roomId ?? null);
  const [mode, setMode] = useState<ComposeMode | null>(null);
  const [threadRoot, setThreadRoot] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [roomSettingsOpen, setRoomSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const dropFilesRef = useRef<((files: FileList | File[]) => void) | null>(null);
  const scrollToEventRef = useRef<((eventId: string) => void) | null>(null);
  const { showError } = useToast();

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDragOver(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      if (e.dataTransfer.files.length) dropFilesRef.current?.(e.dataTransfer.files);
    },
  };

  const handle = useMemo(() => {
    if (!account || !selection) return null;
    try {
      const h = account.room(selection.roomId);
      // Freeze the unread marker at open, so it survives the read receipt.
      h.snapshotReadMarker();
      return h;
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, selection?.roomId]);

  // Close the thread panel, search bar and room settings when switching rooms.
  useEffect(() => {
    setThreadRoot(null);
    setSearchOpen(false);
    setThreadsOpen(false);
    setRoomSettingsOpen(false);
  }, [selection?.roomId]);

  // Mark read when the room is open and messages arrive.
  const version = useRoomVersion(account, selection?.roomId ?? null);
  useEffect(() => {
    if (!handle) return;
    const t = setTimeout(() => handle.markRead().catch(() => undefined), 600);
    return () => clearTimeout(t);
  }, [handle, version]);

  if (!selection || !account || !handle) {
    return (
      <main className="chat-pane">
        <div className="empty-state">
          <div className="empty-glyph">
            <IconChat size={30} />
          </div>
          <h2>Welcome to Materix</h2>
          <p>Select a chat on the left, or start a new conversation.</p>
        </div>
      </main>
    );
  }

  const summary = account.rooms().find((r) => r.roomId === selection.roomId);
  const details = handle.details();
  const typing = typingText(handle.typingNames());

  // For a two-person direct message, resolve the peer's presence so the header
  // can show it (sub-line + avatar dot). Presence is often disabled server-side,
  // in which case presenceOf returns offline/unknown and we fall back cleanly.
  const isDm = !!(details.isDirect && summary?.isDirect);
  const peerId =
    isDm && details.memberCount === 2
      ? handle.members().find((m) => m.userId !== account.info().userId)?.userId
      : undefined;
  const presence = peerId ? account.presenceOf(peerId) : undefined;
  const dmSubText =
    account.info().userId === details.name ? "" : (presenceLabel(presence) ?? "Direct message");

  const dropEnabled = !summary?.isInvite;

  return (
    <main className="chat-pane" {...(dropEnabled ? dragHandlers : {})}>
      {dragOver && dropEnabled && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            <IconPaperclip size={32} />
            <div className="drop-overlay-title">Drop to send</div>
            <div className="drop-overlay-sub">Images open the editor; other files upload directly</div>
          </div>
        </div>
      )}
      <header className="chat-header">
        {/* Element-style room header: an in-app Back is always first, in every
            layout — it and hardware Back both return chat → room list. */}
        <button className="icon-btn" onClick={onBack} title="Back to chat list" aria-label="Back to chat list">
          <IconBack size={20} />
        </button>
        <Avatar
          account={account}
          mxc={summary?.avatarUrl}
          name={details.name}
          id={details.roomId}
          size={40}
          presence={presence?.presence}
        />
        <div className="chat-header-info">
          <div className="chat-header-name">
            {details.name}
            {details.isEncrypted && (
              <span className="enc-lock" title="End-to-end encrypted">
                <IconLock size={14} />
              </span>
            )}
          </div>
          <div className="chat-header-sub">
            {isDm ? dmSubText : `${details.memberCount} member${details.memberCount === 1 ? "" : "s"}`}
            {details.topic ? ` · ${details.topic}` : ""}
          </div>
        </div>
        {details.memberCount === 2 && !summary?.isInvite && (
          <>
            <button
              className="icon-btn"
              onClick={() => account.calls.startVoiceCall(selection.roomId).catch(showError)}
              title="Voice call"
              aria-label="Voice call"
            >
              <IconPhone size={20} />
            </button>
            <button
              className="icon-btn"
              onClick={() => account.calls.startVideoCall(selection.roomId).catch(showError)}
              title="Video call"
              aria-label="Video call"
            >
              <IconVideo size={20} />
            </button>
          </>
        )}
        <button
          className={`icon-btn${searchOpen ? " active" : ""}`}
          onClick={() => setSearchOpen((v) => !v)}
          title="Search messages"
          aria-label="Search messages"
          aria-pressed={searchOpen}
        >
          <IconSearch size={20} />
        </button>
        <button
          className={`icon-btn${threadsOpen ? " active" : ""}`}
          onClick={() => setThreadsOpen((v) => !v)}
          title="Threads"
          aria-label="Threads"
          aria-pressed={threadsOpen}
        >
          <IconThreads size={20} />
        </button>
        {details.canEditRoom && details.memberCount !== 2 && (
          // Direct room-settings access for editors. Two-person rooms show the
          // call buttons instead (no header space on phones); they keep
          // settings via Room info → Room settings.
          <button
            className="icon-btn"
            onClick={() => setRoomSettingsOpen(true)}
            title="Room settings"
            aria-label="Room settings"
          >
            <IconSettings size={20} />
          </button>
        )}
        <button className="icon-btn" onClick={onToggleDetails} title="Room info" aria-label="Room info">
          <IconInfo size={20} />
        </button>
      </header>

      <PinnedBanner handle={handle} version={version} onJump={(eventId) => scrollToEventRef.current?.(eventId)} />

      {searchOpen && (
        <RoomSearch
          handle={handle}
          version={version}
          onClose={() => setSearchOpen(false)}
          onJump={(eventId) => scrollToEventRef.current?.(eventId)}
        />
      )}

      <LiveBeacons account={account} roomId={selection.roomId} />
      <Timeline
        account={account}
        handle={handle}
        onReply={(item: TimelineItem) => setMode({ kind: "reply", item })}
        onEdit={(item: TimelineItem) => setMode({ kind: "edit", item })}
        scrollToRef={scrollToEventRef}
      />
      <div className="typing-bar" aria-live="polite">
        {typing}
      </div>
      {summary?.isInvite ? (
        <div className="composer-wrap">
          <div className="composer" style={{ flexDirection: "row", padding: "var(--sp-3)", gap: "var(--sp-2)" }}>
            <button
              className="btn primary"
              style={{ flex: 1 }}
              onClick={() => account.acceptInvite(selection.roomId).catch(showError)}
            >
              Accept invitation
            </button>
            <button
              className="btn secondary"
              style={{ flex: 1 }}
              onClick={() => {
                account.rejectInvite(selection.roomId).catch(showError);
                onBack();
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ) : (
        <Composer
          handle={handle}
          accountKey={selection.accountKey}
          mode={mode}
          onClearMode={() => setMode(null)}
          dropFilesRef={dropFilesRef}
        />
      )}
      {threadsOpen && !threadRoot && (
        <ThreadsPanel
          account={account}
          handle={handle}
          onOpenThread={(rootEventId) => {
            setThreadsOpen(false);
            setThreadRoot(rootEventId);
          }}
          onClose={() => setThreadsOpen(false)}
        />
      )}
      {threadRoot && (
        <ThreadView account={account} handle={handle} rootEventId={threadRoot} onClose={() => setThreadRoot(null)} />
      )}
      {roomSettingsOpen && (
        <RoomSettingsDialog account={account} handle={handle} onClose={() => setRoomSettingsOpen(false)} />
      )}
    </main>
  );
}

/**
 * Sub-line text for a DM peer's presence, or null when nothing meaningful is
 * known (server disabled presence, user never seen) — the caller then falls
 * back to the plain "Direct message" label. "Last seen" reuses the room-list
 * time formatting (time today, weekday this week, date otherwise).
 */
function presenceLabel(
  p?: { presence: "online" | "unavailable" | "offline"; lastActiveTs?: number; statusMsg?: string },
): string | null {
  if (!p) return null;
  const lastSeen = p.lastActiveTs ? `Last seen ${formatListTime(p.lastActiveTs)}` : null;
  if (p.presence === "online") return p.statusMsg || "Online";
  if (p.presence === "unavailable") return p.statusMsg || lastSeen || "Away";
  return lastSeen || p.statusMsg || null;
}

/**
 * Banner under the chat header summarizing the room's pinned messages
 * (m.room.pinned_events). Collapsed, it shows the count and the latest pin;
 * expanded, a small panel lists every pin with jump-to-message and (when
 * permitted) unpin. Re-derives when `version` bumps, which includes room state
 * changes, so pins update live.
 */
function PinnedBanner({
  handle,
  version,
  onJump,
}: {
  handle: RoomHandle;
  version: number;
  onJump: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { showError } = useToast();
  // version participates in the memo so pins re-derive on state changes.
  const pins = useMemo(() => handle.pinnedMessages(), [handle, version]);
  const canPin = handle.canPin();

  // Collapse automatically once the room has no pins left.
  useEffect(() => {
    if (pins.length === 0) setOpen(false);
  }, [pins.length]);

  if (pins.length === 0) return null;
  const latest = pins[pins.length - 1];

  return (
    <div className="pinned">
      <button
        className="pinned-banner"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${pins.length} pinned message${pins.length === 1 ? "" : "s"}`}
      >
        <span className="pinned-icon">
          <IconPin size={16} />
        </span>
        <span className="pinned-banner-body">
          <span className="pinned-banner-title">
            {pins.length} pinned message{pins.length === 1 ? "" : "s"}
          </span>
          <span className="pinned-banner-preview">
            {latest.senderName && <b>{latest.senderName}: </b>}
            {latest.preview}
          </span>
        </span>
        <span className="pinned-chevron" aria-hidden="true">
          {open ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
        </span>
      </button>
      {open && (
        <div className="pinned-list" role="list" aria-label="Pinned messages">
          {[...pins].reverse().map((p) => (
            <div key={p.eventId} className="pinned-item" role="listitem">
              <button
                className="pinned-item-jump"
                onClick={() => {
                  onJump(p.eventId);
                  setOpen(false);
                }}
                disabled={!p.loaded}
                title={p.loaded ? "Jump to message" : "Message not loaded"}
              >
                <span className="pinned-item-sender">{p.senderName || "Message"}</span>
                <span className="pinned-item-preview">{p.preview}</span>
              </button>
              {canPin && (
                <button
                  className="icon-btn"
                  onClick={() => handle.unpin(p.eventId).catch(showError)}
                  title="Unpin"
                  aria-label="Unpin message"
                >
                  <IconX size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * In-room search with two scopes:
 *   - "loaded" (default): synchronous, local-only match over the events already
 *     in the timeline (see RoomHandle.searchMessages). Users can pull older
 *     pages to widen it.
 *   - "server": full-history search via the homeserver's search API
 *     (RoomHandle.searchServer), debounced. Some homeservers don't index
 *     messages, so this scope surfaces a clear error when unsupported.
 * Both scopes yield the same SearchHit shape and render through one list.
 */
function RoomSearch({
  handle,
  version,
  onClose,
  onJump,
}: {
  handle: RoomHandle;
  version: number;
  onClose: () => void;
  onJump: (eventId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"loaded" | "server">("loaded");
  const [active, setActive] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [serverResults, setServerResults] = useState<SearchHit[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { showError } = useToast();

  // `version` bumps when the timeline changes (e.g. after pulling older pages),
  // so local results re-derive against the freshly loaded events.
  const localResults = useMemo(() => handle.searchMessages(query), [handle, query, version]);
  const canPaginate = handle.canPaginateBack();

  const trimmed = query.trim();

  // Server search: debounce the query, then hit the homeserver. A generation
  // counter drops results from stale in-flight requests (query changed since).
  useEffect(() => {
    if (scope !== "server") return;
    if (!trimmed) {
      setServerResults([]);
      setServerError(null);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    setServerError(null);
    const t = setTimeout(() => {
      handle
        .searchServer(trimmed)
        .then((hits) => {
          if (cancelled) return;
          setServerResults(hits);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setServerResults([]);
          setServerError(e instanceof MaterixError ? e.userMessage : "Search failed. Try again.");
        })
        .finally(() => {
          if (!cancelled) setServerLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, scope, trimmed]);

  const results = scope === "server" ? serverResults : localResults;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset the cursor whenever the query or scope changes.
  useEffect(() => {
    setActive(0);
  }, [query, scope]);

  const jump = (idx: number) => {
    if (!results.length) return;
    const i = ((idx % results.length) + results.length) % results.length;
    setActive(i);
    onJump(results[i].eventId);
  };

  const loadOlder = () => {
    if (loadingOlder || !canPaginate) return;
    setLoadingOlder(true);
    // Pull a few pages so the searchable window widens noticeably in one tap.
    (async () => {
      for (let n = 0; n < 3 && handle.canPaginateBack(); n++) await handle.paginateBack();
    })()
      .catch(showError)
      .finally(() => setLoadingOlder(false));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      jump(active + (e.shiftKey ? -1 : 1));
    }
  };

  const count = results.length;
  const serverScope = scope === "server";
  return (
    <div className="room-search" onKeyDown={onKeyDown}>
      <div className="room-search-bar">
        <div className="room-search-field">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            type="text"
            placeholder={serverScope ? "Search all history…" : "Search loaded messages…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search messages in this room"
          />
        </div>
        <span className="room-search-count" aria-live="polite">
          {serverScope && serverLoading ? "…" : trimmed ? (count ? `${active + 1}/${count}` : "0") : ""}
        </span>
        <button
          className="icon-btn"
          onClick={() => jump(active - 1)}
          disabled={!count}
          title="Previous match"
          aria-label="Previous match"
        >
          <IconChevronUp size={18} />
        </button>
        <button
          className="icon-btn"
          onClick={() => jump(active + 1)}
          disabled={!count}
          title="Next match"
          aria-label="Next match"
        >
          <IconChevronDown size={18} />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close search" aria-label="Close search">
          <IconX size={18} />
        </button>
      </div>
      <div className="room-search-scope" role="tablist" aria-label="Search scope">
        <button
          className={`room-search-scope-btn${!serverScope ? " active" : ""}`}
          role="tab"
          aria-selected={!serverScope}
          onClick={() => setScope("loaded")}
        >
          Loaded
        </button>
        <button
          className={`room-search-scope-btn${serverScope ? " active" : ""}`}
          role="tab"
          aria-selected={serverScope}
          onClick={() => setScope("server")}
        >
          All history
        </button>
      </div>
      {trimmed && (
        <div className="room-search-results" role="listbox" aria-label="Search results">
          {results.map((hit, i) => (
            <button
              key={hit.eventId}
              className={`room-search-result${i === active ? " active" : ""}`}
              role="option"
              aria-selected={i === active}
              onClick={() => jump(i)}
            >
              <span className="room-search-result-meta">
                <span className="room-search-result-sender">{hit.senderName}</span>
                <span className="room-search-result-time">{formatTime(hit.ts)}</span>
              </span>
              <span className="room-search-result-snippet">
                <Emphasized text={hit.snippet} term={trimmed} />
              </span>
            </button>
          ))}
          {serverScope ? (
            <>
              {serverLoading && <div className="room-search-status">Searching all history…</div>}
              {!serverLoading && serverError && (
                <div className="room-search-status room-search-error">{serverError}</div>
              )}
              {!serverLoading && !serverError && !count && (
                <div className="room-search-empty">No matches in this room's history.</div>
              )}
            </>
          ) : (
            <>
              {!count && (
                <div className="room-search-empty">
                  No matches in loaded history.
                  {canPaginate && (
                    <>
                      {" "}
                      <button className="room-search-more" onClick={loadOlder} disabled={loadingOlder}>
                        {loadingOlder ? "Loading…" : "Search older messages"}
                      </button>
                    </>
                  )}
                </div>
              )}
              {count > 0 && canPaginate && (
                <button className="room-search-more" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? "Loading older messages…" : "Search older messages"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Render `text` with case-insensitive occurrences of `term` wrapped in <mark>. */
function Emphasized({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const at = lower.indexOf(needle, i);
    if (at === -1) {
      out.push(text.slice(i));
      break;
    }
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={k++}>{text.slice(at, at + needle.length)}</mark>);
    i = at + needle.length;
  }
  return <>{out}</>;
}
