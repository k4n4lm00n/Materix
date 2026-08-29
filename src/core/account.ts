// One logged-in account: owns a MatrixClient, exposes UI-facing snapshots and
// actions. Contract: docs/api-contract.md "Core boundary".

import {
  BeaconEvent,
  ClientEvent,
  EventType,
  IndexedDBStore,
  MatrixEventEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  createClient,
  type IContent,
  type MatrixClient,
  type Room,
} from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent";
import type {
  AccountInfo,
  AccountKey,
  CreateRoomOpts,
  PublicRoomResult,
  PublicRoomsPage,
  RoomSummary,
  SessionData,
  SpaceSummary,
  SyncStateName,
  UserSearchResult,
} from "./types";
import { RoomHandle } from "./roomHandle";
import { previewText } from "./markdown";
import { CryptoFacade, cryptoCallbacks } from "./crypto";
import { CallManager } from "./calls";
import { readStorageKey } from "./cryptoStoreKey";
import { Emitter } from "./emitter";
import { toMaterixError } from "./errors";
import { DecryptedCache } from "./decryptedCache";

/** Deterministic per-account accent color. */
function accountColor(key: AccountKey): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}

export class MatrixAccount {
  readonly events = new Emitter<string>(); // "rooms" | "self" | `room:${roomId}`
  readonly crypto: CryptoFacade;
  readonly calls = new CallManager();
  client!: MatrixClient;
  syncState: SyncStateName = "initial";
  startError?: string;
  /** False if the E2EE crypto engine failed to initialise (most commonly the
   *  device's System WebView is too old to run the crypto WASM — it needs
   *  WebAssembly reference-types, i.e. Chromium 96+). Encryption, decryption of
   *  E2EE rooms, and device verification are all unavailable; the UI warns
   *  loudly and refuses to continue without explicit user acknowledgement. */
  cryptoAvailable = true;
  cryptoError?: string;
  /** The unlocked crypto-store key (if the account is encrypted), for passcode re-wrapping. */
  storageKey?: Uint8Array<ArrayBuffer>;
  /** Persistent decrypted-plaintext cache (see decryptedCache.ts, issue #4). */
  private decryptedCache: DecryptedCache;
  private handles = new Map<string, RoomHandle>();
  private directRooms = new Set<string>();
  /** Client-side per-room settings, synced via io.materix.settings account data. */
  private roomSettings: Record<string, { archived?: boolean; mutedUntil?: number }> = {};

  constructor(
    readonly key: AccountKey,
    readonly session: SessionData,
  ) {
    this.crypto = new CryptoFacade(key);
    this.decryptedCache = new DecryptedCache(key);
  }

  async start(): Promise<void> {
    const store = new IndexedDBStore({
      indexedDB: window.indexedDB,
      dbName: `materix-sync-${this.key}`,
    });
    this.client = createClient({
      baseUrl: this.session.homeserverUrl,
      accessToken: this.session.accessToken,
      refreshToken: this.session.refreshToken,
      userId: this.session.userId,
      deviceId: this.session.deviceId,
      store,
      timelineSupport: true,
      cryptoCallbacks,
    });
    this.crypto.bind(this.client);
    this.calls.bind(this.client);
    // Must run after the store is assigned to the client (SDK requirement).
    await store.startup();

    try {
      // Encrypt the crypto store at rest ONLY when a key exists for this account
      // (created at login for new accounts). Legacy accounts have no key, so
      // this stays byte-for-byte the original unencrypted init — never a
      // migration of an existing store. Same db prefix, no deletion.
      const storageKey = await readStorageKey(this.key);
      this.storageKey = storageKey ?? undefined;
      await this.client.initRustCrypto({
        cryptoDatabasePrefix: `materix-crypto-${this.key}`,
        ...(storageKey ? { storageKey } : {}),
      });
      this.crypto.attach();
      this.cryptoAvailable = true;
      // Open the decrypted-plaintext cache (issue #4). Best-effort: a failure
      // here only means we fall back to normal per-launch re-decryption.
      this.decryptedCache.open().catch((err) =>
        console.warn(`decrypted cache open failed for ${this.session.userId}`, err),
      );
    } catch (e) {
      // Crypto init failed — most often the device's WebView is too old to run
      // the crypto WASM (needs WebAssembly reference-types, Chromium 96+), but
      // could also be store corruption. Either way E2EE + verification are off.
      // Flag it so the UI can warn loudly and gate; keep running so unencrypted
      // messaging still works, but never silently pretend crypto is present.
      this.cryptoAvailable = false;
      this.cryptoError = e instanceof Error ? e.message : String(e);
      console.error(`rust crypto init failed for ${this.session.userId}`, e);
      this.events.emit("self");
    }

    this.wireListeners();
    await this.client.startClient({ initialSyncLimit: 20 });
  }

  private wireListeners(): void {
    const c = this.client;
    const bumpRooms = () => this.events.emit("rooms");
    const bumpRoom = (room?: Room | null) => {
      if (room) this.events.emit(`room:${room.roomId}`);
      this.events.emit("rooms");
    };

    c.on(ClientEvent.Sync, (state) => {
      const prev = this.syncState;
      this.syncState =
        state === SyncState.Prepared || state === SyncState.Syncing
          ? "ready"
          : state === SyncState.Error || state === SyncState.Reconnecting
            ? "error"
            : state === SyncState.Stopped
              ? "stopped"
              : "syncing";
      if (prev !== this.syncState) this.events.emit("self");
      bumpRooms();
    });
    c.on(RoomEvent.Timeline, (ev, room) => {
      // Edit invalidation (issue #4): an m.replace supersedes its target's
      // content, so the target's cached plaintext must go — better to
      // re-decrypt than resurrect a stale pre-edit body. The relation is
      // cleartext even on encrypted events, so this fires before the edit
      // itself is decrypted (and again from stored sync on every cold start).
      const rel = ev.getRelation();
      if (rel?.rel_type === "m.replace" && rel.event_id) this.evictCached(rel.event_id, ev.getRoomId());
      bumpRoom(room);
    });
    c.on(RoomEvent.LocalEchoUpdated, (_ev, room) => bumpRoom(room));
    c.on(RoomEvent.Receipt, (_ev, room) => bumpRoom(room));
    c.on(RoomEvent.Redaction, (ev, room) => {
      // Drop any cached plaintext for the redacted target so we never resurrect
      // redacted content from the decrypted cache.
      const targetId = ev.getAssociatedId();
      if (targetId) this.evictCached(targetId, room?.roomId ?? ev.getRoomId());
      bumpRoom(room);
    });
    // Explicit marked-unread flag (MSC2867) arrives as room account data.
    c.on(RoomEvent.AccountData, (ev, room) => {
      const type = ev.getType();
      if (type === "m.marked_unread" || type === "com.famedly.marked_unread") bumpRoom(room);
    });
    c.on(RoomEvent.Name, () => bumpRooms());
    c.on(RoomEvent.MyMembership, () => bumpRooms());
    c.on(RoomEvent.Tags, () => bumpRooms());
    c.on(RoomMemberEvent.Typing, (_ev, member) => bumpRoom(c.getRoom(member.roomId)));
    c.on(RoomStateEvent.Events, (ev) => bumpRoom(c.getRoom(ev.getRoomId() ?? undefined)));
    c.on(MatrixEventEvent.Decrypted, (ev) => {
      // An edit that only reveals its m.replace relation once decrypted still
      // invalidates its target (usually already caught cleartext in Timeline).
      const rel = ev.getRelation();
      if (rel?.rel_type === "m.replace" && rel.event_id) this.evictCached(rel.event_id, ev.getRoomId());
      // Persist the freshly-decrypted plaintext so a future cold launch can skip
      // re-decrypting it (issue #4). No-op on decryption failure (see record()).
      this.decryptedCache.record(ev);
      bumpRoom(c.getRoom(ev.getRoomId() ?? undefined));
    });
    // Live-location beacons: re-render on new position / liveness change.
    c.on(BeaconEvent.New as never, ((_ev: unknown, beacon: { roomId: string }) =>
      bumpRoom(c.getRoom(beacon.roomId))) as never);
    c.on(BeaconEvent.Update as never, ((_ev: unknown, beacon: { roomId: string }) =>
      bumpRoom(c.getRoom(beacon.roomId))) as never);
    c.on(BeaconEvent.LivenessChange as never, ((_live: boolean, beacon: { roomId: string }) =>
      bumpRoom(c.getRoom(beacon.roomId))) as never);
    c.on(BeaconEvent.LocationUpdate as never, (() => this.events.emit("rooms")) as never);
    c.on(ClientEvent.AccountData, (ev) => {
      if (ev.getType() === EventType.Direct) {
        this.rebuildDirectSet();
        bumpRooms();
      }
      if (ev.getType() === "io.materix.settings") {
        this.loadRoomSettings();
        bumpRooms();
      }
      // Ignore-list changes (this device or another) must re-render timelines so
      // ignored senders' messages collapse/reveal immediately.
      if (ev.getType() === EventType.IgnoredUserList) bumpRooms();
    });
    this.loadRoomSettings();
    // Presence updates arrive as `m.presence` events on the sync stream; the
    // SDK has already refreshed the corresponding User object by the time this
    // fires, so a plain "rooms" bump re-renders any header reading presenceOf().
    // Presence is frequently disabled server-side, in which case no such event
    // ever arrives and this simply never fires.
    c.on(ClientEvent.Event, (ev) => {
      if (ev.getType() === EventType.Presence) this.events.emit("rooms");
    });
    c.on(CryptoEvent.VerificationRequestReceived as never, (() => this.events.emit("self")) as never);
    this.rebuildDirectSet();
  }

  private loadRoomSettings(): void {
    const content = this.client
      .getAccountData("io.materix.settings" as never)
      ?.getContent<{ rooms?: Record<string, { archived?: boolean; mutedUntil?: number }> }>();
    this.roomSettings = content?.rooms ?? {};
  }

  private async saveRoomSettings(roomId: string, patch: { archived?: boolean; mutedUntil?: number }): Promise<void> {
    const next = { ...this.roomSettings };
    const entry = { ...next[roomId], ...patch };
    // Drop no-op/default entries to keep the account-data blob small.
    if (!entry.archived && (!entry.mutedUntil || entry.mutedUntil < Date.now())) delete next[roomId];
    else next[roomId] = entry;
    this.roomSettings = next;
    await this.client.setAccountData("io.materix.settings" as never, { rooms: next } as never);
    this.events.emit("rooms");
  }

  async setArchived(roomId: string, archived: boolean): Promise<void> {
    await this.saveRoomSettings(roomId, { archived });
  }

  isMuted(roomId: string): boolean {
    const until = this.roomSettings[roomId]?.mutedUntil ?? 0;
    return until > Date.now();
  }

  /** durationMs: undefined/0 unmutes, Infinity mutes forever. */
  async setMuted(roomId: string, durationMs: number | undefined): Promise<void> {
    const mutedUntil = !durationMs ? 0 : durationMs === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + durationMs;
    await this.saveRoomSettings(roomId, { mutedUntil });
  }

  /** Send a read receipt for (and clear marked-unread on) every joined room. */
  async markAllRead(): Promise<void> {
    if (!this.client) return;
    const rooms = this.client
      .getVisibleRooms()
      .filter((r) => r.getMyMembership() === "join" && !r.isSpaceRoom());
    await Promise.allSettled(rooms.map((r) => this.room(r.roomId).markRead()));
  }

  private rebuildDirectSet(): void {
    this.directRooms.clear();
    const direct = this.client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
    for (const roomIds of Object.values(direct)) {
      for (const id of roomIds) this.directRooms.add(id);
    }
  }

  info(): AccountInfo {
    const me = this.session.userId;
    const user = this.client?.getUser(me);
    return {
      key: this.key,
      userId: me,
      displayName: user?.displayName ?? me.split(":")[0].slice(1),
      avatarUrl: user?.avatarUrl ?? undefined,
      homeserverName: me.split(":").slice(1).join(":"),
      color: accountColor(this.key),
      syncState: this.syncState,
    };
  }

  /**
   * Presence snapshot for a user, read from the SDK's User model. Degrades to
   * "offline" when the user object is absent or the server never sent presence
   * (many homeservers disable it) — callers should treat an unknown/offline
   * result with no `lastActiveTs` as "no indicator". `lastActiveTs` is only
   * returned when a presence event has actually been seen and the user isn't
   * flagged currently-active (in which case `lastActiveAgo` is stale).
   */
  presenceOf(userId: string): {
    presence: "online" | "unavailable" | "offline";
    lastActiveTs?: number;
    statusMsg?: string;
  } {
    const user = this.client?.getUser(userId);
    if (!user || !user.presence) return { presence: "offline" };
    const presence =
      user.presence === "online" || user.presence === "unavailable" ? user.presence : "offline";
    const lastActiveTs =
      user.lastPresenceTs && user.lastActiveAgo && !user.currentlyActive
        ? user.lastPresenceTs - user.lastActiveAgo
        : undefined;
    return { presence, lastActiveTs, statusMsg: user.presenceStatusMsg || undefined };
  }

  rooms(): RoomSummary[] {
    if (!this.client) return [];
    return this.client
      .getVisibleRooms()
      .filter((r) => {
        const m = r.getMyMembership();
        return m === "join" || m === "invite";
      })
      .map((r) => this.summarize(r));
  }

  /** Visible joined spaces (rooms where isSpaceRoom() is true). */
  spaces(): SpaceSummary[] {
    if (!this.client) return [];
    return this.client
      .getVisibleRooms()
      .filter((r) => r.getMyMembership() === "join" && r.isSpaceRoom())
      .map((r) => ({
        accountKey: this.key,
        roomId: r.roomId,
        name: r.name || "Unnamed space",
        avatarUrl: r.getMxcAvatarUrl() ?? undefined,
      }));
  }

  /**
   * Resolve the flat set of non-space child room ids of a space via its
   * `m.space.child` state, descending into nested spaces. Cycle-guarded so a
   * space that (directly or transitively) lists itself cannot loop forever.
   */
  spaceChildRoomIds(spaceRoomId: string): Set<string> {
    const result = new Set<string>();
    const visited = new Set<string>();
    const descend = (roomId: string): void => {
      if (visited.has(roomId)) return;
      visited.add(roomId);
      const room = this.client.getRoom(roomId);
      if (!room) return;
      for (const ev of room.currentState.getStateEvents(EventType.SpaceChild)) {
        const childId = ev.getStateKey();
        // An `m.space.child` with no `via` is a removed/invalid link.
        if (!childId || !Array.isArray(ev.getContent().via)) continue;
        if (this.client.getRoom(childId)?.isSpaceRoom()) descend(childId);
        else result.add(childId);
      }
    };
    descend(spaceRoomId);
    return result;
  }

  private summarize(room: Room): RoomSummary {
    const isInvite = room.getMyMembership() === "invite";
    const tags = room.tags ?? {};
    const last = this.lastPreview(room);
    const settings = this.roomSettings[room.roomId] ?? {};
    const mutedUntil = settings.mutedUntil && settings.mutedUntil > Date.now() ? settings.mutedUntil : 0;
    const inviter = isInvite
      ? room.getMember(this.session.userId)?.events.member?.getSender()
      : undefined;
    return {
      accountKey: this.key,
      roomId: room.roomId,
      name: room.name || "Unnamed room",
      avatarUrl: room.getMxcAvatarUrl() ?? this.dmPartnerAvatar(room),
      isDirect: this.directRooms.has(room.roomId) || !!room.getDMInviter(),
      isEncrypted: room.hasEncryptionStateEvent(),
      isFavorite: "m.favourite" in tags,
      isLowPriority: "m.lowpriority" in tags,
      isArchived: !!settings.archived && !isInvite,
      mutedUntil,
      isInvite,
      inviterName: inviter ? (room.getMember(inviter)?.name ?? inviter) : undefined,
      isSpace: room.isSpaceRoom(),
      unreadCount: room.getUnreadNotificationCount() ?? 0,
      markedUnread: this.room(room.roomId).isMarkedUnread(),
      highlightCount: room.getUnreadNotificationCount("highlight" as never) ?? 0,
      lastActivityTs: room.getLastActiveTimestamp(),
      lastEvent: last,
      typing: this.room(room.roomId).typingNames(),
    };
  }

  private dmPartnerAvatar(room: Room): string | undefined {
    if (!this.directRooms.has(room.roomId)) return undefined;
    const other = room.getJoinedMembers().find((m) => m.userId !== this.session.userId);
    return other?.getMxcAvatarUrl() ?? undefined;
  }

  private lastPreview(room: Room): RoomSummary["lastEvent"] {
    const events = room.getLiveTimeline().getEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const type = ev.getType();
      if (type === "m.poll.start" || type === "org.matrix.msc3381.poll.start") {
        const member = room.getMember(ev.getSender() ?? "");
        return {
          ts: ev.getTs(),
          senderName: ev.getSender() === this.session.userId ? "You" : (member?.name ?? ev.getSender() ?? ""),
          preview: "Poll",
        };
      }
      if (type !== EventType.RoomMessage && type !== EventType.RoomMessageEncrypted && type !== "m.sticker") continue;
      const member = room.getMember(ev.getSender() ?? "");
      const senderName =
        ev.getSender() === this.session.userId ? "You" : (member?.name ?? ev.getSender() ?? "");
      let preview: string;
      if (ev.isRedacted()) preview = "Message deleted";
      else if (ev.isDecryptionFailure() || ev.isBeingDecrypted() || type === EventType.RoomMessageEncrypted)
        preview = "Encrypted message";
      else {
        const content = ev.getContent();
        if (content["m.relates_to"]?.rel_type === "m.replace") continue;
        const msgtype = content.msgtype as string;
        preview =
          msgtype === "m.image"
            ? "Photo"
            : msgtype === "m.video"
              ? "Video"
              : msgtype === "m.audio"
                ? content["org.matrix.msc3245.voice"]
                  ? "Voice message"
                  : "Audio"
                : msgtype === "m.file"
                  ? "File"
                  : msgtype === "m.location"
                    ? "Location"
                    : msgtype === "m.key.verification.request"
                      ? "Verification request"
                      : previewText((content.body as string) ?? "");
      }
      return { ts: ev.getTs(), senderName, preview: preview.slice(0, 120) };
    }
    return undefined;
  }

  /** Drop an event's cached plaintext everywhere: the persistent row and any
   * warm in-memory copy held by the room's handle (issue #4 invalidation). */
  private evictCached(eventId: string, roomId?: string | null): void {
    this.decryptedCache.evict(eventId);
    if (roomId) this.handles.get(roomId)?.dropCachedClear(eventId);
  }

  room(roomId: string): RoomHandle {
    let h = this.handles.get(roomId);
    if (!h) {
      const room = this.client.getRoom(roomId);
      if (!room) throw new Error(`unknown room ${roomId}`);
      // The decrypted cache + a render bump let the handle serve the issue #4
      // read fast-path (cached plaintext while the SDK re-decrypts).
      h = new RoomHandle(this.client, room, this.decryptedCache, () => {
        this.events.emit(`room:${roomId}`);
        this.events.emit("rooms");
      });
      this.handles.set(roomId, h);
    }
    return h;
  }

  async createRoom(opts: CreateRoomOpts): Promise<string> {
    const initialState = [];
    if (opts.encrypted !== false && !opts.public) {
      initialState.push({
        type: EventType.RoomEncryption,
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      });
    }
    try {
      const res = await this.client.createRoom({
        name: opts.name,
        topic: opts.topic,
        invite: opts.invite,
        is_direct: opts.direct,
        visibility: (opts.public ? "public" : "private") as never,
        preset: (opts.public ? "public_chat" : "private_chat") as never,
        initial_state: initialState as never,
      });
      if (opts.direct && opts.invite?.length === 1) {
        await this.addToDirects(opts.invite[0], res.room_id);
      }
      return res.room_id;
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Send an already-cleaned content (see RoomHandle.contentForForward) into a room. */
  async forward(toRoomId: string, content: IContent): Promise<void> {
    try {
      await this.client.sendMessage(toRoomId, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  async startDm(userId: string): Promise<string> {
    const existing = this.findExistingDm(userId);
    if (existing) return existing;
    return this.createRoom({ direct: true, invite: [userId], encrypted: true });
  }

  /**
   * Find a joined DM room with `userId`, or undefined. Prefers rooms recorded
   * in `m.direct`, then falls back to any joined two-person room shared with
   * just this user — `m.direct` is frequently stale (e.g. the DM was created
   * by the other side), and without this fallback we'd spawn a duplicate room.
   */
  private findExistingDm(userId: string): string | undefined {
    const direct = this.client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
    for (const roomId of direct[userId] ?? []) {
      const room = this.client.getRoom(roomId);
      if (room && room.getMyMembership() === "join") return roomId;
    }
    for (const room of this.client.getRooms()) {
      if (room.getMyMembership() !== "join") continue;
      const joined = room.getJoinedMembers();
      if (joined.length === 2 && joined.some((m) => m.userId === userId)) return room.roomId;
    }
    return undefined;
  }

  /** Whether `userId` is a joined member of `roomId` (for picking a verification room). */
  isJoinedMember(roomId: string, userId: string): boolean {
    return this.client.getRoom(roomId)?.getMember(userId)?.membership === "join";
  }

  private async addToDirects(userId: string, roomId: string): Promise<void> {
    const direct = this.client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>() ?? {};
    const next = { ...direct, [userId]: [...new Set([...(direct[userId] ?? []), roomId])] };
    await this.client.setAccountData(EventType.Direct, next as never);
  }

  async joinRoom(idOrAlias: string): Promise<string> {
    try {
      const room = await this.client.joinRoom(idOrAlias.trim());
      return room.roomId;
    } catch (e) {
      throw toMaterixError(e, "join");
    }
  }

  async acceptInvite(roomId: string): Promise<void> {
    try {
      await this.client.joinRoom(roomId);
    } catch (e) {
      // joinRoom issues the `/join` request first and only then runs post-join
      // crypto steps (MSC4268 key-bundle import). Those can throw on an
      // encrypted-room invite even though the server-side join already
      // succeeded — which would otherwise surface as "accept doesn't work".
      // Treat it as success if we did in fact become joined (now or once the
      // next sync reflects it); rethrow only when the join genuinely failed.
      if (this.client.getRoom(roomId)?.getMyMembership() === "join") return;
      if (await this.waitForJoin(roomId, 5000)) return;
      throw toMaterixError(e, "join");
    }
  }

  /** Resolve true if our membership in `roomId` becomes "join" within `timeoutMs`. */
  private waitForJoin(roomId: string, timeoutMs: number): Promise<boolean> {
    if (this.client.getRoom(roomId)?.getMyMembership() === "join") return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (joined: boolean) => {
        this.client.off(RoomEvent.MyMembership, onChange);
        clearTimeout(timer);
        resolve(joined);
      };
      const onChange = (room: Room, membership: string) => {
        if (room.roomId === roomId && membership === "join") done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.client.on(RoomEvent.MyMembership, onChange as never);
    });
  }

  async rejectInvite(roomId: string): Promise<void> {
    try {
      await this.client.leave(roomId);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async setRoomTag(roomId: string, tag: "m.favourite" | "m.lowpriority", enabled: boolean): Promise<void> {
    if (enabled) await this.client.setRoomTag(roomId, tag, { order: 0.5 });
    else await this.client.deleteRoomTag(roomId, tag);
  }

  /**
   * Browse a server's public room directory. `server` defaults to the user's
   * own homeserver; pass another domain to explore it (federation permitting).
   */
  async publicRooms(opts: { query?: string; server?: string; since?: string }): Promise<PublicRoomsPage> {
    try {
      const res = await this.client.publicRooms({
        server: opts.server?.trim() || undefined,
        limit: 30,
        since: opts.since,
        ...(opts.query?.trim()
          ? { filter: { generic_search_term: opts.query.trim() } }
          : {}),
      });
      const rooms: PublicRoomResult[] = res.chunk.map((r) => ({
        roomId: r.room_id,
        name: r.name || r.canonical_alias || r.room_id,
        topic: r.topic,
        alias: r.canonical_alias,
        avatarMxc: r.avatar_url,
        memberCount: r.num_joined_members ?? 0,
        worldReadable: !!r.world_readable,
        joinedAlready: this.client.getRoom(r.room_id)?.getMyMembership() === "join",
      }));
      return { rooms, nextBatch: res.next_batch, totalEstimate: res.total_room_count_estimate };
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async searchUsers(query: string): Promise<UserSearchResult[]> {
    try {
      const res = await this.client.searchUserDirectory({ term: query, limit: 10 });
      const results = res.results.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      }));
      // Exact user IDs are always offerable even when not in the directory.
      if (/^@[^:]+:.+/.test(query.trim()) && !results.some((r) => r.userId === query.trim())) {
        results.unshift({ userId: query.trim(), displayName: undefined, avatarUrl: undefined });
      }
      return results;
    } catch {
      return /^@[^:]+:.+/.test(query.trim()) ? [{ userId: query.trim() }] : [];
    }
  }

  /** User IDs on the account-level ignore list (m.ignored_user_list). */
  ignoredUsers(): string[] {
    return this.client?.getIgnoredUsers() ?? [];
  }

  /** Add or remove `userId` from the account ignore list. */
  async setIgnored(userId: string, ignored: boolean): Promise<void> {
    const current = this.client.getIgnoredUsers();
    const next = ignored
      ? [...new Set([...current, userId])]
      : current.filter((u) => u !== userId);
    // No-op if nothing changes (avoids a needless account-data round-trip).
    if (next.length === current.length && next.every((u) => current.includes(u))) return;
    try {
      await this.client.setIgnoredUsers(next);
      this.events.emit("rooms");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async setProfile(p: { displayName?: string; avatarFile?: File }): Promise<void> {
    try {
      if (p.displayName !== undefined) await this.client.setDisplayName(p.displayName);
      if (p.avatarFile) {
        const upload = await this.client.uploadContent(p.avatarFile, { type: p.avatarFile.type });
        await this.client.setAvatarUrl(upload.content_uri);
      }
      this.events.emit("self");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async stop(): Promise<void> {
    this.client?.stopClient();
    this.decryptedCache.close();
  }

  /** Sign out server-side (best effort) and destroy every local store. */
  async destroy(): Promise<void> {
    try {
      await this.client.logout(true);
    } catch {
      this.client.stopClient();
    }
    try {
      await this.client.store.deleteAllData();
    } catch {
      // stores may already be gone
    }
    try {
      await this.client.clearStores();
    } catch {
      // best effort
    }
    indexedDB.deleteDatabase(`materix-crypto-${this.key}::matrix-sdk-crypto`);
    // Wipe cached plaintext on sign-out (privacy: never outlive the session).
    this.decryptedCache.close();
    indexedDB.deleteDatabase(`materix-decrypted-${this.key}`);
  }
}
