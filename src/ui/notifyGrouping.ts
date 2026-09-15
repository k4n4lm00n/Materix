// Pure tally/payload math for Android grouped notifications.
//
// The Kotlin notifier (packaging/android/push/MaterixPush.kt) is STATELESS: JS
// owns the running count of messages notified "since the room was last viewed"
// and hands the native side the COMPLETE desired state (child + account
// summary) on every post. This module holds that state machine as pure,
// side-effect-free reducers so it is table-testable without a DOM or the
// Matrix SDK (cf. src/ui/notifyGrouping.test.ts).
//
// Grouping model (Element-style): one GROUP per account, one child
// notification per room, one group-summary per account. Counts accumulate per
// room and per account; viewing a room zeroes that room and recomputes the
// account remainder.

/** Privacy mode for the notification line ("off" is handled before we get here). */
export type PrivacyMode = "preview" | "name";

/** Max message lines kept for a single room's child notification (InboxStyle). */
export const MAX_ROOM_LINES = 5;
/** Max lines shown on the per-account group summary (InboxStyle). */
export const MAX_ACCOUNT_LINES = 7;
/** Upper bound on the per-account recent-line buffer (memory guard only). */
export const MAX_RECENT = 50;

/** One incoming, already-notifiable message. `body`/`title` are pre-reduced by
 * the caller exactly as the legacy notifier does (so no decrypted content
 * flows here in "name" mode — body is "New message"). */
export interface IncomingMessage {
  accountKey: string;
  accountLabel: string;
  roomId: string;
  roomName: string;
  sender: string;
  /** Privacy-reduced content text ("New message" in "name" mode). */
  body: string;
  /** Child content title, e.g. "alice · #room". */
  title: string;
  mode: PrivacyMode;
  /** Android channel the caller resolved (per-room override or per-account). */
  channelId?: string;
}

/** The full desired state for one native `notifyMessage` post (flat wire shape
 * consumed 1:1 by MaterixPush.notifyMessage in Kotlin). Carries BOTH the child
 * (room) fields and the recomputed account-summary fields. */
export interface NotifyMessagePayload {
  accountKey: string;
  accountLabel: string;
  roomId: string;
  channelId?: string;
  title: string;
  body: string;
  /** Last ≤MAX_ROOM_LINES lines for this room (child InboxStyle). */
  roomLines: string[];
  /** Running count of messages notified in this room since last viewed. */
  roomCount: number;
  /** Last ≤MAX_ACCOUNT_LINES lines across the account (summary InboxStyle). */
  accountLines: string[];
  /** Running count across every room of this account. */
  totalCount: number;
}

/** Desired state for a native `clearRoom` post after a room is viewed. */
export interface ClearRoomPayload {
  accountKey: string;
  accountLabel: string;
  roomId: string;
  /** Account total AFTER removing the viewed room. 0 ⇒ cancel the summary. */
  remainingTotal: number;
  /** Same value as `remainingTotal`, under the field name the Kotlin summary
   * renderer reads (`notifyMessage` uses `totalCount`); keeps the badge count
   * correct on the clear-on-open re-post. */
  totalCount: number;
  /** Recomputed summary lines (the viewed room's lines removed). */
  accountLines: string[];
  /** Channel for re-posting the summary; injected by the caller. */
  channelId?: string;
}

interface RoomState {
  roomId: string;
  roomName: string;
  count: number;
  lines: string[];
}

interface AccountState {
  accountKey: string;
  accountLabel: string;
  rooms: Map<string, RoomState>;
  /** Cross-room recent lines (for the summary), each tagged with its room so a
   * room-viewed clear can drop exactly that room's lines. */
  recent: { roomId: string; line: string }[];
}

/** Per-account grouping state, keyed by accountKey. */
export type GroupingState = Map<string, AccountState>;

export function createGroupingState(): GroupingState {
  return new Map();
}

/** Build the privacy-respecting InboxStyle line for a message. "preview" shows
 * "sender: body"; "name" shows the sender only (never any content). */
export function formatLine(sender: string, body: string, mode: PrivacyMode): string {
  return mode === "preview" ? `${sender}: ${body}` : sender;
}

function totalOf(acct: AccountState): number {
  let n = 0;
  for (const r of acct.rooms.values()) n += r.count;
  return n;
}

/** Fold one incoming message into the tally and produce the full native
 * payload. Mutates `state` in place (JS owns the single session-scoped map)
 * and returns it alongside the payload. */
export function reduceIncoming(
  state: GroupingState,
  msg: IncomingMessage,
): { state: GroupingState; payload: NotifyMessagePayload } {
  let acct = state.get(msg.accountKey);
  if (!acct) {
    acct = {
      accountKey: msg.accountKey,
      accountLabel: msg.accountLabel,
      rooms: new Map(),
      recent: [],
    };
    state.set(msg.accountKey, acct);
  }
  acct.accountLabel = msg.accountLabel;

  let room = acct.rooms.get(msg.roomId);
  if (!room) {
    room = { roomId: msg.roomId, roomName: msg.roomName, count: 0, lines: [] };
    acct.rooms.set(msg.roomId, room);
  }
  room.roomName = msg.roomName;

  const line = formatLine(msg.sender, msg.body, msg.mode);
  room.count += 1;
  room.lines.push(line);
  if (room.lines.length > MAX_ROOM_LINES) {
    room.lines = room.lines.slice(-MAX_ROOM_LINES);
  }

  acct.recent.push({ roomId: msg.roomId, line });
  if (acct.recent.length > MAX_RECENT) {
    acct.recent = acct.recent.slice(-MAX_RECENT);
  }

  const totalCount = totalOf(acct);
  const accountLines = acct.recent.slice(-MAX_ACCOUNT_LINES).map((r) => r.line);

  const payload: NotifyMessagePayload = {
    accountKey: msg.accountKey,
    accountLabel: msg.accountLabel,
    roomId: msg.roomId,
    ...(msg.channelId ? { channelId: msg.channelId } : {}),
    title: msg.title,
    body: msg.body,
    roomLines: room.lines.slice(),
    roomCount: room.count,
    accountLines,
    totalCount,
  };
  return { state, payload };
}

/** Zero a room's tally (it was opened/read) and produce the clear payload with
 * the recomputed account remainder. Returns `clear: null` when nothing was
 * tracked for that room (so the caller can skip the native call). */
export function reduceRoomViewed(
  state: GroupingState,
  accountKey: string,
  roomId: string,
): { state: GroupingState; clear: ClearRoomPayload | null } {
  const acct = state.get(accountKey);
  if (!acct || !acct.rooms.has(roomId)) return { state, clear: null };

  acct.rooms.delete(roomId);
  acct.recent = acct.recent.filter((r) => r.roomId !== roomId);

  const remainingTotal = totalOf(acct);
  const accountLines = acct.recent.slice(-MAX_ACCOUNT_LINES).map((r) => r.line);
  const clear: ClearRoomPayload = {
    accountKey,
    accountLabel: acct.accountLabel,
    roomId,
    remainingTotal,
    totalCount: remainingTotal,
    accountLines,
  };
  if (remainingTotal === 0) state.delete(accountKey);
  return { state, clear };
}
