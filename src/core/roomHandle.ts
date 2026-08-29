// Per-room facade: builds TimelineItem[] snapshots from the SDK timeline and
// carries all room-scoped actions (send, edit, react, receipts, membership).
// Contract: docs/api-contract.md "Core boundary".

import {
  Direction,
  EventStatus,
  EventType,
  GuestAccess,
  HistoryVisibility,
  JoinRule,
  type IContent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from "matrix-js-sdk";
import { lastReceiptableEvent } from "./readReceipt";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { parseBeaconContent } from "matrix-js-sdk/lib/content-helpers";
import type {
  EncryptedFileInfo,
  HistoryVisibilityValue,
  JoinRuleValue,
  LiveBeacon,
  MediaItem,
  MemberSummary,
  MessageBody,
  PinnedMessage,
  PollData,
  RoomDetails,
  SearchHit,
  ThreadSummary,
  TimelineItem,
} from "./types";
import { MaterixError, toMaterixError } from "./errors";
import type { CachedClear, DecryptedCache } from "./decryptedCache";
import {
  markdownToMatrixHtml,
  sanitizeIncomingHtml,
  stripReplyFallbackHtml,
  stripReplyFallbackText,
  escapeHtml,
} from "./markdown";

/**
 * Best-effort video poster: decode the file in a hidden <video>, grab a frame
 * shortly after the start, and JPEG-encode it, returning the poster blob plus
 * the video's pixel size and duration. Resolves null if the browser can't
 * decode the codec (the send then proceeds without a thumbnail). Bounded by a
 * timeout so a stuck decode never blocks the upload.
 */
function videoPoster(
  file: File,
): Promise<{ blob: Blob; w: number; h: number; durationMs: number } | null> {
  return new Promise((resolve) => {
    let done = false;
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    const finish = (result: { blob: Blob; w: number; h: number; durationMs: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 8000);
    v.muted = true;
    v.preload = "metadata";
    v.crossOrigin = "anonymous";
    v.onloadeddata = () => {
      // Seek a little past the first frame to avoid an all-black opener.
      const t = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(0.1, v.duration / 2) : 0;
      if (v.currentTime === t) v.onseeked?.(new Event("seeked"));
      else v.currentTime = t;
    };
    v.onseeked = () => {
      try {
        const w = v.videoWidth;
        const h = v.videoHeight;
        if (!w || !h) return finish(null);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, w, h);
        canvas.toBlob(
          (blob) =>
            finish(
              blob
                ? { blob, w, h, durationMs: Math.round((Number.isFinite(v.duration) ? v.duration : 0) * 1000) }
                : null,
            ),
          "image/jpeg",
          0.72,
        );
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}

// MSC2867 marked-unread room account data (stable + unstable Famedly prefix).
const MARKED_UNREAD = "m.marked_unread";
const MARKED_UNREAD_UNSTABLE = "com.famedly.marked_unread";

// MSC3381 poll event types (stable + unstable prefixes).
const POLL_START = ["m.poll.start", "org.matrix.msc3381.poll.start"];
const POLL_RESPONSE = ["m.poll.response", "org.matrix.msc3381.poll.response"];
const POLL_END = ["m.poll.end", "org.matrix.msc3381.poll.end"];

function pollContent(ev: MatrixEvent): Record<string, unknown> | undefined {
  const c = ev.getContent();
  return (c["m.poll.start"] ?? c["org.matrix.msc3381.poll.start"] ?? (c.question ? c : undefined)) as
    | Record<string, unknown>
    | undefined;
}

/** Text that in-room search should match: plain-message bodies and media
 * captions. Media without a caption carries only its filename as body, which
 * we skip so search matches what the user typed, not attachment names. A
 * caption is present when MSC2530 `filename` is set (body != filename). */
function searchableText(content: IContent): string {
  const msgtype = content.msgtype as string | undefined;
  const body = stripReplyFallbackText((content.body as string) ?? "");
  if (!body) return "";
  if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") return body;
  // Media caption (image/video/file/audio with an MSC2530 filename).
  if (typeof content.filename === "string" && content.filename !== body) return body;
  return "";
}

/** A trimmed, single-line excerpt around a match, with ellipses on cut sides. */
function snippetAround(text: string, idx: number, len: number): string {
  const pad = 32;
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + len + pad);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return s;
}

const RENDERED_STATE = new Set<string>([
  EventType.RoomMember,
  EventType.RoomName,
  EventType.RoomTopic,
  EventType.RoomCreate,
  EventType.RoomEncryption,
]);

export class RoomHandle {
  /** Read-marker position frozen when the room was opened, so it doesn't
   * vanish the moment we send the read receipt. */
  private frozenMarker: string | null = null;

  /** Read fast-path (issue #4): warm in-memory layer over the persistent
   * decrypted cache. IndexedDB reads are async but the snapshot builders are
   * synchronous, so cached plaintext is batch-loaded into this map and the
   * builders read it synchronously on the re-render that follows. */
  private warmClear = new Map<string, CachedClear>();
  /** Event ids already looked up (hit or miss) so each id costs at most one
   * IndexedDB read per session. */
  private warmChecked = new Set<string>();

  constructor(
    private client: MatrixClient,
    private room: Room,
    /** Persistent decrypted-plaintext cache; absent = fast-path disabled. */
    private cache?: DecryptedCache,
    /** Bumps the room's render version once warm cache hits arrive. */
    private onCacheWarm?: () => void,
  ) {}

  get roomId(): string {
    return this.room.roomId;
  }

  /** Capture the current read position; call when the user opens the room. */
  snapshotReadMarker(): void {
    const myUserId = this.client.getUserId()!;
    const events = this.room.getLiveTimeline().getEvents();
    let readUpTo = this.room.getEventReadUpTo(myUserId, false);
    if (readUpTo) {
      const idx = events.findIndex((e) => e.getId() === readUpTo);
      // Marker is pointless when nothing follows it, or only our own sends do.
      if (idx === -1 || idx === events.length - 1 || events.slice(idx + 1).every((e) => e.getSender() === myUserId)) {
        readUpTo = null;
      }
    }
    this.frozenMarker = readUpTo;
  }

  /** True while the SDK holds no clear content for an (encrypted) event —
   * decryption pending, failed, or not yet attempted. Once js-sdk decrypts,
   * getType()/getContent() reflect the clear event and this turns false. */
  private awaitingDecryption(ev: MatrixEvent): boolean {
    return (
      !ev.isRedacted() &&
      (ev.isDecryptionFailure() || ev.isBeingDecrypted() || ev.getType() === EventType.RoomMessageEncrypted)
    );
  }

  /**
   * Read fast-path (issue #4): asynchronously batch-load persisted plaintext
   * for still-encrypted events into the warm map, then bump the room so the
   * synchronous builders re-run with the hits. Never blocks the snapshot
   * being built right now; best-effort throughout (a cache fault only means
   * the normal re-decryption path is used).
   */
  private warmFromCache(events: MatrixEvent[]): void {
    const cache = this.cache;
    if (!cache) return;
    const wanted: string[] = [];
    for (const ev of events) {
      const id = ev.getId();
      if (!id) continue;
      if (!this.awaitingDecryption(ev)) {
        // The SDK has (re-)decrypted or redacted it — its view wins from here.
        this.warmClear.delete(id);
        continue;
      }
      if (this.warmChecked.has(id)) continue;
      this.warmChecked.add(id);
      wanted.push(id);
    }
    if (!wanted.length) return;
    void Promise.all(wanted.map((id) => cache.get(id))).then((rows) => {
      let hits = 0;
      for (const row of rows) {
        if (!row) continue;
        this.warmClear.set(row.eventId, row);
        hits++;
      }
      if (hits) this.onCacheWarm?.();
    });
  }

  /** Invalidation hook (redaction / m.replace edit): drop any warm cached
   * plaintext for the event so it can't be rendered stale. */
  dropCachedClear(eventId: string): void {
    this.warmClear.delete(eventId);
  }

  /**
   * An event's clear content: the SDK's when it has decrypted (the SDK is
   * always the source of truth), else the warm cached plaintext persisted by
   * a previous session, else undefined while the event is still opaque.
   */
  private clearContentOf(ev: MatrixEvent): IContent | undefined {
    if (!this.awaitingDecryption(ev)) return ev.getContent();
    const id = ev.getId();
    return id ? (this.warmClear.get(id)?.content as IContent | undefined) : undefined;
  }

  /** Build the renderable timeline snapshot (oldest first). */
  timeline(): TimelineItem[] {
    const myUserId = this.client.getUserId()!;
    const events = this.room.getLiveTimeline().getEvents();
    this.warmFromCache(events);
    const readUpTo = this.frozenMarker;
    const items: TimelineItem[] = [];
    let lastDay = "";
    let prev: { sender: string; ts: number } | null = null;

    const push = (ev: MatrixEvent, item: TimelineItem) => {
      const day = new Date(item.ts).toDateString();
      if (day !== lastDay) {
        items.push({
          id: `day-${day}-${item.ts}`,
          kind: "day-divider",
          sender: item.sender,
          ts: item.ts,
        });
        lastDay = day;
        prev = null;
      }
      item.groupStart =
        item.kind !== "message" ||
        !prev ||
        prev.sender !== item.sender.userId ||
        item.ts - prev.ts > 5 * 60_000;
      items.push(item);
      prev = item.kind === "message" ? { sender: item.sender.userId, ts: item.ts } : null;
      if (readUpTo && ev.getId() === readUpTo) {
        items.push({ id: "read-marker", kind: "read-marker", sender: item.sender, ts: item.ts });
        prev = null;
      }
    };

    const ignored = new Set(this.client.getIgnoredUsers());
    for (const ev of events) {
      const item = this.toItem(ev, myUserId, ignored);
      if (item) push(ev, item);
    }
    return items;
  }

  private toItem(ev: MatrixEvent, myUserId: string, ignored?: Set<string>): TimelineItem | null {
    const type = ev.getType();
    const sender = this.senderOf(ev);
    const base = {
      id: ev.getId() ?? ev.getTxnId() ?? `local-${ev.getTs()}`,
      eventId: ev.getId() ?? undefined,
      sender,
      ts: ev.getTs(),
      isMine: ev.getSender() === myUserId,
    };

    // Collapse message/poll content from ignored users into a subtle placeholder.
    // Membership/state events are left to render normally (never crash on them).
    if (
      ignored?.has(ev.getSender() ?? "") &&
      (type === EventType.RoomMessage ||
        type === EventType.RoomMessageEncrypted ||
        type === "m.sticker" ||
        POLL_START.includes(type))
    ) {
      return { ...base, kind: "ignored" };
    }

    if (ev.isRedacted()) {
      if (type !== EventType.RoomMessage && type !== EventType.RoomMessageEncrypted && type !== "m.sticker") return null;
      return { ...base, kind: "redacted" };
    }
    if (ev.isDecryptionFailure() || ev.isBeingDecrypted() || type === EventType.RoomMessageEncrypted) {
      // Read fast-path (issue #4): while the SDK holds no clear content for
      // this event, render the plaintext persisted by a previous session
      // instead of the "waiting" placeholder. Display-only accelerator: the
      // SDK stays the source of truth — the moment it decrypts, this branch
      // is skipped and the item is built from the SDK's clear event.
      const cached = base.eventId ? this.warmClear.get(base.eventId) : undefined;
      if (cached) {
        const item = this.cachedItem(ev, base, cached, myUserId);
        if (item !== undefined) return item; // null = hidden (e.g. a cached edit)
      }
      return { ...base, kind: "encrypted-pending" };
    }

    if (type === EventType.RoomMessage || type === "m.sticker") {
      const content = ev.getContent();
      // Edit events render through their target, not standalone.
      if (content["m.relates_to"]?.rel_type === "m.replace") return null;
      // Verification requests are handled by the verification dialog, not
      // rendered as chat text (their fallback body is confusing).
      if (content.msgtype === "m.key.verification.request") {
        return {
          ...base,
          kind: "state",
          stateText: `${sender.name} sent a verification request`,
        };
      }
      const body = this.toBody(content, type === "m.sticker");
      if (!body) return null;
      const status = ev.status;
      // A message that is itself a thread root carries a reply count so the
      // main timeline can show a "N replies" affordance.
      const thread = base.eventId ? this.room.getThread(base.eventId) : null;
      const threadReplyCount = thread && thread.length > 0 ? thread.length : undefined;
      return {
        ...base,
        kind: "message",
        body,
        threadReplyCount,
        edited: !!ev.replacingEvent(),
        sendState:
          status === EventStatus.SENT || status === null
            ? status === null
              ? undefined
              : "sent"
            : status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED
              ? "failed"
              : "sending",
        replyTo: this.replyContext(content),
        reactions: this.reactionsFor(ev),
        receipts: this.receiptsFor(ev, myUserId),
      };
    }

    if (POLL_START.includes(type)) {
      const poll = this.buildPoll(ev, myUserId);
      if (!poll) return null;
      return { ...base, kind: "poll", poll, reactions: this.reactionsFor(ev), receipts: this.receiptsFor(ev, myUserId) };
    }

    if (RENDERED_STATE.has(type)) {
      const text = this.stateText(ev);
      if (!text) return null;
      return { ...base, kind: type === EventType.RoomMember ? "member" : "state", stateText: text };
    }
    return null;
  }

  /**
   * Build a timeline item from a previous session's cached plaintext while
   * the SDK hasn't (re-)decrypted `ev`. Relations, reactions and receipts
   * still come from the live SDK event; nothing is injected back into the
   * SDK (`MatrixEvent.clearEvent` has no supported setter). Returns null when
   * the cached event renders as nothing (an edit), undefined when it can't be
   * rendered from cache (caller falls back to the pending placeholder).
   */
  private cachedItem(
    ev: MatrixEvent,
    base: Pick<TimelineItem, "id" | "eventId" | "sender" | "ts" | "isMine">,
    cached: CachedClear,
    myUserId: string,
  ): TimelineItem | null | undefined {
    if (cached.type !== EventType.RoomMessage && cached.type !== "m.sticker") return undefined;
    const content = cached.content as IContent;
    // Mirror the decrypted path: edits render through their target, and
    // verification requests are not rendered as chat text.
    if (content["m.relates_to"]?.rel_type === "m.replace") return null;
    if (content.msgtype === "m.key.verification.request") {
      return { ...base, kind: "state", stateText: `${base.sender.name} sent a verification request` };
    }
    const body = this.toBody(content, cached.type === "m.sticker");
    if (!body) return undefined;
    const thread = base.eventId ? this.room.getThread(base.eventId) : null;
    return {
      ...base,
      kind: "message",
      body,
      threadReplyCount: thread && thread.length > 0 ? thread.length : undefined,
      edited: !!ev.replacingEvent(),
      replyTo: this.replyContext(content),
      reactions: this.reactionsFor(ev),
      receipts: this.receiptsFor(ev, myUserId),
    };
  }

  private buildPoll(ev: MatrixEvent, myUserId: string): PollData | null {
    const start = pollContent(ev);
    if (!start) return null;
    const id = ev.getId();
    if (!id) return null;
    const question =
      ((start["m.text"] as string) ??
        (start.question as { "m.text"?: string; body?: string })?.["m.text"] ??
        (start.question as { body?: string })?.body ??
        "Poll") as string;
    const kind = ((start.kind as string) ?? "").includes("undisclosed") ? "undisclosed" : "disclosed";
    const maxSelections = Math.max(1, (start.max_selections as number) ?? 1);
    const rawAnswers = (start.answers as { id: string; "m.text"?: string; answer?: { "m.text"?: string } }[]) ?? [];
    const answers = rawAnswers.map((a) => ({
      id: a.id,
      text: (a["m.text"] ?? a.answer?.["m.text"] ?? a.id) as string,
      votes: 0,
      chosenByMe: false,
    }));
    const validIds = new Set(answers.map((a) => a.id));

    // Aggregate: latest response per sender (relations), ignore after poll end.
    const timelineSet = this.room.getUnfilteredTimelineSet();
    const ended = POLL_END.some(
      (t) => (timelineSet.relations.getChildEventsForEvent(id, "m.reference", t)?.getRelations().length ?? 0) > 0,
    );
    const latestBySender = new Map<string, { ts: number; ids: string[] }>();
    for (const relType of POLL_RESPONSE) {
      const rel = timelineSet.relations.getChildEventsForEvent(id, "m.reference", relType);
      for (const r of rel?.getRelations() ?? []) {
        const sender = r.getSender();
        if (!sender || r.isRedacted()) continue;
        const resp = (r.getContent()["m.poll.response"] ?? r.getContent()["org.matrix.msc3381.poll.response"]) as
          | { answers?: string[] }
          | undefined;
        const picks = (resp?.answers ?? []).filter((a) => validIds.has(a)).slice(0, maxSelections);
        const prev = latestBySender.get(sender);
        if (!prev || r.getTs() > prev.ts) latestBySender.set(sender, { ts: r.getTs(), ids: picks });
      }
    }
    let total = 0;
    for (const [sender, { ids }] of latestBySender) {
      for (const pick of ids) {
        const ans = answers.find((a) => a.id === pick);
        if (!ans) continue;
        ans.votes++;
        total++;
        if (sender === myUserId) ans.chosenByMe = true;
      }
    }
    return { eventId: id, question, kind, maxSelections, ended, answers, totalVotes: total };
  }

  private senderOf(ev: MatrixEvent): TimelineItem["sender"] {
    const userId = ev.getSender() ?? "";
    const member = this.room.getMember(userId);
    return {
      userId,
      name: member?.name ?? userId,
      avatarUrl: member?.getMxcAvatarUrl() ?? undefined,
    };
  }

  private toBody(content: IContent, isSticker: boolean): MessageBody | null {
    const msgtype: string = isSticker ? "m.image" : (content.msgtype as string);
    const text = stripReplyFallbackText((content.body as string) ?? "");
    if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
      let html: string | undefined;
      if (content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string") {
        html = sanitizeIncomingHtml(stripReplyFallbackHtml(content.formatted_body));
      }
      return { msgtype, text, html };
    }
    if (msgtype === "m.location" || content.geo_uri) {
      const geoUri = (content.geo_uri as string) ?? "";
      const coords = /geo:([-\d.]+),([-\d.]+)/.exec(geoUri);
      return {
        msgtype: "m.location",
        text: text || "Location",
        geoUri,
        lat: coords ? parseFloat(coords[1]) : undefined,
        lon: coords ? parseFloat(coords[2]) : undefined,
      };
    }
    const info = (content.info ?? {}) as Record<string, unknown>;
    const file = content.file as EncryptedFileInfo | undefined;
    const mxc = (file?.url ?? content.url) as string | undefined;
    if (!mxc) return null;
    if (msgtype === "m.image" || msgtype === "m.video") {
      const thumbFile = info.thumbnail_file as EncryptedFileInfo | undefined;
      return {
        msgtype,
        text: text || "attachment",
        mxc,
        file,
        thumbMxc: (thumbFile?.url ?? info.thumbnail_url) as string | undefined,
        thumbFile,
        w: info.w as number | undefined,
        h: info.h as number | undefined,
        mime: info.mimetype as string | undefined,
        size: info.size as number | undefined,
        durationMs: msgtype === "m.video" ? (info.duration as number | undefined) : undefined,
      };
    }
    if (msgtype === "m.audio") {
      const voice = "org.matrix.msc3245.voice" in content;
      const audioMeta = (content["org.matrix.msc1767.audio"] ?? {}) as { duration?: number; waveform?: number[] };
      return {
        msgtype: "m.audio",
        text: text || "audio",
        mxc,
        file,
        mime: info.mimetype as string | undefined,
        size: info.size as number | undefined,
        voice,
        durationMs: audioMeta.duration ?? (info.duration as number | undefined),
        waveform: audioMeta.waveform,
      };
    }
    if (msgtype === "m.file") {
      return {
        msgtype: "m.file",
        text: text || "file",
        mxc,
        file,
        mime: info.mimetype as string | undefined,
        size: info.size as number | undefined,
      };
    }
    // Unknown msgtype: fall back to plain text rendering.
    return text ? { msgtype: "m.text", text } : null;
  }

  /** One-line preview of an event's body, redaction/decryption-aware; falls
   * back to the warm decrypted cache while the SDK hasn't decrypted yet. */
  private previewOf(ev: MatrixEvent): string {
    if (ev.isRedacted()) return "…";
    const content = this.clearContentOf(ev);
    if (!content) return "…";
    const body = stripReplyFallbackText((content.body as string) ?? "attachment");
    return (body.split("\n")[0] || "attachment").slice(0, 140);
  }

  private replyContext(content: IContent): TimelineItem["replyTo"] {
    const replyId = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    if (!replyId) return undefined;
    const target = this.room.findEventById(replyId);
    if (!target) return { sender: "", preview: "…", eventId: replyId };
    const member = this.room.getMember(target.getSender() ?? "");
    const targetContent = target.isRedacted() ? undefined : this.clearContentOf(target);
    const preview = targetContent
      ? stripReplyFallbackText((targetContent.body as string) ?? "attachment")
      : "…";
    return {
      sender: member?.name ?? target.getSender() ?? "",
      preview: preview.slice(0, 200),
      eventId: replyId,
    };
  }

  private reactionsFor(ev: MatrixEvent): TimelineItem["reactions"] {
    const id = ev.getId();
    if (!id) return undefined;
    const rel = this.room
      .getUnfilteredTimelineSet()
      .relations.getChildEventsForEvent(id, "m.annotation", EventType.Reaction);
    const sorted = rel?.getSortedAnnotationsByKey();
    if (!sorted?.length) return undefined;
    const me = this.client.getUserId();
    const out = sorted
      .map(([key, evs]) => {
        const live = [...evs].filter((e) => !e.isRedacted());
        return {
          key,
          count: live.length,
          mine: live.some((e) => e.getSender() === me),
        };
      })
      .filter((r) => r.count > 0);
    return out.length ? out : undefined;
  }

  private receiptsFor(ev: MatrixEvent, myUserId: string): TimelineItem["receipts"] {
    const receipts = this.room.getReceiptsForEvent(ev);
    const out: NonNullable<TimelineItem["receipts"]> = [];
    for (const r of receipts) {
      if (r.type !== "m.read" || r.userId === myUserId || r.userId === ev.getSender()) continue;
      const member = this.room.getMember(r.userId);
      out.push({
        userId: r.userId,
        name: member?.name ?? r.userId,
        avatarUrl: member?.getMxcAvatarUrl() ?? undefined,
      });
    }
    return out.length ? out.slice(0, 12) : undefined;
  }

  private stateText(ev: MatrixEvent): string | null {
    const senderName = this.senderOf(ev).name;
    const type = ev.getType();
    const content = ev.getContent();
    const prev = ev.getPrevContent();
    if (type === EventType.RoomMember) {
      const targetName = (content.displayname as string) ?? ev.getStateKey() ?? "";
      switch (content.membership) {
        case "join":
          if (prev.membership === "join") {
            if (prev.displayname !== content.displayname && content.displayname)
              return `${prev.displayname ?? targetName} is now known as ${content.displayname}`;
            if (prev.avatar_url !== content.avatar_url) return `${targetName} changed their avatar`;
            return null;
          }
          return `${targetName} joined`;
        case "leave":
          if (ev.getStateKey() === ev.getSender())
            return prev.membership === "invite" ? `${targetName} declined the invite` : `${targetName} left`;
          return `${senderName} removed ${(prev.displayname as string) ?? ev.getStateKey()}`;
        case "invite":
          return `${senderName} invited ${targetName}`;
        case "ban":
          return `${senderName} banned ${targetName}`;
        default:
          return null;
      }
    }
    if (type === EventType.RoomName) return content.name ? `${senderName} named the room "${content.name}"` : null;
    if (type === EventType.RoomTopic) return `${senderName} changed the topic`;
    if (type === EventType.RoomCreate) return `${senderName} created the room`;
    if (type === EventType.RoomEncryption) return "End-to-end encryption enabled";
    return null;
  }

  // ---- actions ----

  async sendText(text: string, replyToEventId?: string): Promise<void> {
    const html = markdownToMatrixHtml(text);
    const content: IContent = { msgtype: "m.text", body: text };
    if (html) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = html;
    }
    if (replyToEventId) {
      const target = this.room.findEventById(replyToEventId);
      const fallbackName = target ? this.senderOf(target).name : "";
      const fallbackBody = target ? stripReplyFallbackText((target.getContent().body as string) ?? "") : "";
      content["m.relates_to"] = { "m.in_reply_to": { event_id: replyToEventId } };
      content.body = `> <${target?.getSender() ?? ""}> ${fallbackBody.split("\n")[0]}\n\n${text}`;
      content.format = "org.matrix.custom.html";
      content.formatted_body =
        `<mx-reply><blockquote>${escapeHtml(fallbackName)}: ${escapeHtml(fallbackBody.slice(0, 200))}</blockquote></mx-reply>` +
        (html ?? `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`);
    }
    try {
      await this.client.sendMessage(this.roomId, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  // ---- threads ----

  /** All threads in the room, newest activity first. */
  threads(): ThreadSummary[] {
    const out: ThreadSummary[] = [];
    for (const thread of this.room.getThreads()) {
      const root = thread.rootEvent;
      if (!root) continue;
      const latest = thread.replyToEvent ?? thread.lastReply() ?? root;
      out.push({
        rootEventId: thread.id,
        rootSenderName: this.senderOf(root).name,
        rootPreview: this.previewOf(root),
        replyCount: thread.length,
        latestTs: latest.getTs(),
        latestPreview: this.previewOf(latest),
      });
    }
    return out.sort((a, b) => b.latestTs - a.latestTs);
  }

  /** Renderable items for one thread: the root followed by its replies. */
  threadItems(rootEventId: string): TimelineItem[] {
    const myUserId = this.client.getUserId()!;
    const thread = this.room.getThread(rootEventId);
    if (!thread) return [];
    const events = thread.timeline;
    // The SDK usually seeds the root into the thread timeline, but not always;
    // make sure it is present at the top.
    const ordered =
      events.some((e) => e.getId() === rootEventId) || !thread.rootEvent ? events : [thread.rootEvent, ...events];
    this.warmFromCache(ordered);

    const items: TimelineItem[] = [];
    const ignored = new Set(this.client.getIgnoredUsers());
    let prev: { sender: string; ts: number } | null = null;
    for (const ev of ordered) {
      const item = this.toItem(ev, myUserId, ignored);
      if (!item) continue;
      // Mirror the main timeline's same-sender grouping so avatars/names render.
      item.groupStart =
        item.kind !== "message" || !prev || prev.sender !== item.sender.userId || item.ts - prev.ts > 5 * 60_000;
      items.push(item);
      prev = item.kind === "message" ? { sender: item.sender.userId, ts: item.ts } : null;
    }
    return items;
  }

  /** Send a threaded reply to the given thread root (Markdown-aware). */
  async sendThreadReply(rootEventId: string, text: string): Promise<void> {
    const html = markdownToMatrixHtml(text);
    const content: IContent = { msgtype: "m.text", body: text };
    if (html) {
      content.format = "org.matrix.custom.html";
      content.formatted_body = html;
    }
    // Fall back to the latest known reply so non-threaded clients render a
    // sensible reply chain; the root itself if the thread has no replies yet.
    const thread = this.room.getThread(rootEventId);
    const latestId = thread?.replyToEvent?.getId() ?? thread?.lastReply()?.getId() ?? rootEventId;
    content["m.relates_to"] = {
      rel_type: "m.thread",
      event_id: rootEventId,
      is_falling_back: true,
      "m.in_reply_to": { event_id: latestId },
    };
    try {
      await this.client.sendMessage(this.roomId, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  async edit(eventId: string, newText: string): Promise<void> {
    const html = markdownToMatrixHtml(newText);
    const newContent: IContent = { msgtype: "m.text", body: newText };
    if (html) {
      newContent.format = "org.matrix.custom.html";
      newContent.formatted_body = html;
    }
    const content: IContent = {
      ...newContent,
      body: `* ${newText}`,
      "m.new_content": newContent,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    };
    await this.client.sendMessage(this.roomId, content as never);
  }

  async redact(eventId: string): Promise<void> {
    await this.client.redactEvent(this.roomId, eventId);
  }

  // ---- pinned messages (m.room.pinned_events) ----

  /** Event ids currently pinned in the room, in pin order (latest last). */
  pinnedEventIds(): string[] {
    const pinned = this.room.currentState
      .getStateEvents(EventType.RoomPinnedEvents, "")
      ?.getContent().pinned;
    return Array.isArray(pinned) ? pinned.filter((id): id is string => typeof id === "string") : [];
  }

  isPinned(eventId: string): boolean {
    return this.pinnedEventIds().includes(eventId);
  }

  /**
   * Pinned messages resolved for display, in pin order (latest last). Ids whose
   * event is not in loaded history are still returned (loaded=false) so the
   * banner count matches the pinned state and unpinning stays possible.
   */
  pinnedMessages(): PinnedMessage[] {
    return this.pinnedEventIds().map((eventId) => {
      const ev = this.room.findEventById(eventId);
      if (!ev) return { eventId, senderName: "", preview: "Message not loaded", ts: 0, loaded: false };
      return { eventId, senderName: this.senderOf(ev).name, preview: this.previewOf(ev), ts: ev.getTs(), loaded: true };
    });
  }

  /** Whether I have the power level to change the room's pinned events. */
  canPin(): boolean {
    const me = this.client.getUserId()!;
    const pl = this.room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
    const users = (pl.users ?? {}) as Record<string, number>;
    const myPl = users[me] ?? ((pl.users_default as number) ?? 0);
    const events = (pl.events ?? {}) as Record<string, number>;
    const pinLevel = events[EventType.RoomPinnedEvents] ?? ((pl.state_default as number) ?? 50);
    return myPl >= pinLevel;
  }

  async pin(eventId: string): Promise<void> {
    const current = this.pinnedEventIds();
    if (current.includes(eventId)) return;
    try {
      await this.client.sendStateEvent(this.roomId, EventType.RoomPinnedEvents, { pinned: [...current, eventId] }, "");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async unpin(eventId: string): Promise<void> {
    const current = this.pinnedEventIds();
    if (!current.includes(eventId)) return;
    try {
      await this.client.sendStateEvent(
        this.roomId,
        EventType.RoomPinnedEvents,
        { pinned: current.filter((id) => id !== eventId) },
        "",
      );
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /**
   * Build a cleaned copy of an event's content suitable for re-sending into
   * another room. Keeps only the message-shaping fields and STRIPS
   * `m.relates_to`, so a forward never carries a reply/edit/thread relation.
   * For encrypted media the `file` block (with its per-file key) is reused
   * verbatim — the target room re-encrypts the whole event, so that key stays
   * protected. Returns null when the event is missing or not a forwardable
   * message (redacted, undecryptable, a poll/state event, or a verification
   * request).
   */
  contentForForward(eventId: string): IContent | null {
    const ev = this.room.findEventById(eventId);
    if (!ev) return null;
    const type = ev.getType();
    if (type !== EventType.RoomMessage && type !== "m.sticker") return null;
    if (ev.isRedacted() || ev.isDecryptionFailure() || ev.isBeingDecrypted()) return null;
    const content = ev.getContent();
    if (content.msgtype === "m.key.verification.request") return null;

    const out: IContent = {};
    for (const key of ["msgtype", "body", "formatted_body", "format", "url", "file", "info", "filename"] as const) {
      if (content[key] !== undefined) out[key] = content[key];
    }
    // Stickers carry no msgtype; forward them as images so the target room
    // (which receives an m.room.message) renders them.
    if (out.msgtype === undefined) {
      if (type === "m.sticker") out.msgtype = "m.image";
      else return null;
    }
    // A message with neither text body nor media is nothing to forward.
    if (out.body === undefined && out.url === undefined && out.file === undefined) return null;
    return out;
  }

  /** Toggle own reaction with the given key on an event. */
  async react(eventId: string, key: string): Promise<void> {
    const rel = this.room
      .getUnfilteredTimelineSet()
      .relations.getChildEventsForEvent(eventId, "m.annotation", EventType.Reaction);
    const mine = rel
      ?.getRelations()
      .find((e) => e.getSender() === this.client.getUserId() && e.getContent()["m.relates_to"]?.key === key && !e.isRedacted());
    if (mine?.getId()) {
      await this.client.redactEvent(this.roomId, mine.getId()!);
      return;
    }
    await this.client.sendEvent(this.roomId, EventType.Reaction as never, {
      "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
    } as never);
  }

  /** Cast (or change) a vote on a poll. Empty selection is allowed by spec. */
  async votePoll(pollEventId: string, answerIds: string[]): Promise<void> {
    try {
      await this.client.sendEvent(this.roomId, "m.poll.response" as never, {
        "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
        "m.poll.response": { answers: answerIds },
      } as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  async endPoll(pollEventId: string): Promise<void> {
    await this.client.sendEvent(this.roomId, "m.poll.end" as never, {
      "m.relates_to": { rel_type: "m.reference", event_id: pollEventId },
      "m.poll.end": {},
      "m.text": "The poll has ended.",
    } as never);
  }

  async createPoll(question: string, answers: string[], multiple: boolean): Promise<void> {
    const content = {
      "m.poll.start": {
        kind: "org.matrix.msc3381.poll.disclosed",
        max_selections: multiple ? answers.length : 1,
        question: { "m.text": question },
        answers: answers.map((text, i) => ({ id: `opt${i}`, "m.text": text })),
      },
      "m.text": `${question}\n${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
    };
    try {
      await this.client.sendEvent(this.roomId, "m.poll.start" as never, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  /** Share a static location as an m.location event. */
  async sendLocation(lat: number, lon: number, description?: string): Promise<void> {
    const geoUri = `geo:${lat},${lon}`;
    try {
      await this.client.sendEvent(this.roomId, EventType.RoomMessage as never, {
        msgtype: "m.location",
        body: description || `Location: ${lat}, ${lon}`,
        geo_uri: geoUri,
        "org.matrix.msc3488.location": { uri: geoUri, description },
        "org.matrix.msc3488.asset": { type: "m.pin" },
      } as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  /**
   * Start sharing live location for `durationMs`. Returns a stop() function.
   * Creates an m.beacon_info state event (live=true), then streams m.beacon
   * location updates from the device geolocation until stopped or expired.
   */
  async startLiveLocation(durationMs: number): Promise<() => Promise<void>> {
    const { makeBeaconInfoContent, makeBeaconContent } = await import("matrix-js-sdk/lib/content-helpers");
    const infoContent = makeBeaconInfoContent(durationMs, true, "Live location", "m.self" as never);
    let res;
    try {
      res = await this.client.unstable_createLiveBeacon(this.roomId, infoContent as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
    const beaconInfoId = res.event_id;

    let stopped = false;
    const push = (pos: GeolocationPosition) => {
      if (stopped) return;
      const geoUri = `geo:${pos.coords.latitude},${pos.coords.longitude};u=${Math.round(pos.coords.accuracy)}`;
      const content = makeBeaconContent(geoUri, Math.floor(pos.timestamp || Date.now()), beaconInfoId);
      this.client.sendEvent(this.roomId, "org.matrix.msc3672.beacon" as never, content as never).catch(() => undefined);
    };
    navigator.geolocation.getCurrentPosition(push, () => undefined, { enableHighAccuracy: true });
    const watchId = navigator.geolocation.watchPosition(push, () => undefined, {
      enableHighAccuracy: true,
      maximumAge: 5000,
    });

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(expiry);
      const offContent = makeBeaconInfoContent(durationMs, false, "Live location", "m.self" as never);
      await this.client.unstable_setLiveBeacon(this.roomId, offContent as never).catch(() => undefined);
    };
    const expiry = setTimeout(() => void stop(), durationMs);
    return stop;
  }

  /** Turn off all of my live beacons in this room (any device). */
  async stopMyLiveLocation(): Promise<void> {
    const me = this.client.getUserId();
    const { makeBeaconInfoContent } = await import("matrix-js-sdk/lib/content-helpers");
    for (const beacon of this.room.currentState.beacons.values()) {
      if (beacon.beaconInfoOwner !== me || !beacon.isLive) continue;
      const info = beacon.beaconInfo;
      const off = makeBeaconInfoContent(info.timeout ?? 0, false, info.description, "m.self" as never);
      await this.client.unstable_setLiveBeacon(this.roomId, off as never).catch(() => undefined);
    }
  }

  async sendFile(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    opts?: { caption?: string },
  ): Promise<void> {
    const mime = file.type || "application/octet-stream";
    const msgtype = mime.startsWith("image/")
      ? "m.image"
      : mime.startsWith("video/")
        ? "m.video"
        : mime.startsWith("audio/")
          ? "m.audio"
          : "m.file";
    const info: Record<string, unknown> = { mimetype: mime, size: file.size };
    if (msgtype === "m.image") {
      try {
        const bmp = await createImageBitmap(file);
        info.w = bmp.width;
        info.h = bmp.height;
        bmp.close();
      } catch {
        // dimensions are optional
      }
    }
    // A video carries a poster frame so the recipient sees it instantly instead
    // of waiting for the whole (possibly encrypted) file to download. Generation
    // is best-effort — an undecodable codec just sends without a thumbnail.
    const poster = msgtype === "m.video" ? await videoPoster(file).catch(() => null) : null;
    if (poster) {
      info.w = poster.w;
      info.h = poster.h;
      if (poster.durationMs) info.duration = poster.durationMs;
    }
    // A caption becomes the body; the original filename is preserved separately
    // (MSC2530-style) so it still downloads with a sensible name.
    const caption = opts?.caption?.trim();
    const content: IContent = caption
      ? { msgtype, body: caption, filename: file.name, info }
      : { msgtype, body: file.name, info };
    const progress = onProgress
      ? { progressHandler: (p: { loaded: number; total: number }) => onProgress(p.loaded, p.total) }
      : {};
    const encryptedRoom = this.room.hasEncryptionStateEvent();
    try {
      if (poster) {
        const thumbInfo = { mimetype: "image/jpeg", w: poster.w, h: poster.h, size: poster.blob.size };
        if (encryptedRoom) {
          const encThumb = await encryptAttachment(await poster.blob.arrayBuffer());
          const up = await this.client.uploadContent(new Blob([encThumb.data]), {
            type: "application/octet-stream",
          });
          info.thumbnail_file = { ...encThumb.info, url: up.content_uri, mimetype: "image/jpeg" };
        } else {
          const up = await this.client.uploadContent(poster.blob, { type: "image/jpeg" });
          info.thumbnail_url = up.content_uri;
        }
        info.thumbnail_info = thumbInfo;
      }
      if (encryptedRoom) {
        const encrypted = await encryptAttachment(await file.arrayBuffer());
        const upload = await this.client.uploadContent(new Blob([encrypted.data]), {
          type: "application/octet-stream",
          ...progress,
        });
        content.file = { ...encrypted.info, url: upload.content_uri, mimetype: mime };
      } else {
        const upload = await this.client.uploadContent(file, { type: mime, ...progress });
        content.url = upload.content_uri;
      }
      await this.client.sendMessage(this.roomId, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  /** Send an MSC3245 voice message (m.audio + voice/waveform metadata). */
  async sendVoiceMessage(file: File, durationMs: number, waveform: number[]): Promise<void> {
    const mime = file.type || "audio/ogg";
    const info = { mimetype: mime, size: file.size, duration: durationMs };
    const content: IContent = {
      msgtype: "m.audio",
      body: "Voice message",
      info,
      "org.matrix.msc3245.voice": {},
      "org.matrix.msc1767.audio": { duration: durationMs, waveform },
    };
    try {
      if (this.room.hasEncryptionStateEvent()) {
        const encrypted = await encryptAttachment(await file.arrayBuffer());
        const upload = await this.client.uploadContent(new Blob([encrypted.data]), { type: "application/octet-stream" });
        content.file = { ...encrypted.info, url: upload.content_uri, mimetype: mime };
      } else {
        const upload = await this.client.uploadContent(file, { type: mime });
        content.url = upload.content_uri;
      }
      await this.client.sendMessage(this.roomId, content as never);
    } catch (e) {
      throw toMaterixError(e, "send");
    }
  }

  async resend(localId: string): Promise<void> {
    const ev = this.room
      .getLiveTimeline()
      .getEvents()
      .find((e) => (e.getId() ?? e.getTxnId()) === localId);
    if (ev) await this.client.resendEvent(ev, this.room);
  }

  /**
   * Mark the room read up to its latest event, and clear any explicit
   * marked-unread flag — opening / reading a room always resolves it.
   */
  async markRead(): Promise<void> {
    const events = this.room.getLiveTimeline().getEvents();
    // Only receipt a fully-sent event — never a local echo / failed message,
    // which would be rejected 400 and loop on every timeline update. See
    // lastReceiptableEvent for the rationale + the regression test.
    const last = lastReceiptableEvent(events);
    if (last) {
      await this.client.sendReadReceipt(last);
      await this.client.setRoomReadMarkers(this.roomId, last.getId()!, last);
    }
    if (this.isMarkedUnread()) await this.markUnread(false);
  }

  /**
   * Whether the room carries an explicit MSC2867 marked-unread flag. Reads the
   * stable `m.marked_unread` room account data, falling back to the unstable
   * `com.famedly.marked_unread` type that older clients still write.
   */
  isMarkedUnread(): boolean {
    for (const type of [MARKED_UNREAD, MARKED_UNREAD_UNSTABLE]) {
      const content = this.room.getAccountData(type)?.getContent<{ unread?: boolean }>();
      if (content && typeof content.unread === "boolean") return content.unread;
    }
    return false;
  }

  /**
   * Set (or clear) the explicit MSC2867 marked-unread flag on the room. Writes
   * both the stable and unstable account-data types so clients reading either
   * one stay in sync.
   */
  async markUnread(unread: boolean): Promise<void> {
    try {
      await this.client.setRoomAccountData(this.roomId, MARKED_UNREAD as never, { unread } as never);
      await this.client.setRoomAccountData(this.roomId, MARKED_UNREAD_UNSTABLE as never, { unread } as never);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async setTyping(typing: boolean): Promise<void> {
    try {
      await this.client.sendTyping(this.roomId, typing, 10_000);
    } catch {
      // typing is best-effort
    }
  }

  /** Load older history; resolves false when the start of the room is reached. */
  async paginateBack(limit = 40): Promise<boolean> {
    const tl = this.room.getLiveTimeline();
    if (!tl.getPaginationToken(Direction.Backward)) return false;
    return this.client.paginateEventTimeline(tl, { backwards: true, limit });
  }

  canPaginateBack(): boolean {
    return !!this.room.getLiveTimeline().getPaginationToken(Direction.Backward);
  }

  /** Raw m.room.power_levels content (empty object when unset). */
  private powerLevels(): Record<string, unknown> {
    return this.room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
  }

  /** This user's effective power level in the room. */
  private myPowerLevel(): number {
    const me = this.client.getUserId()!;
    const pl = this.powerLevels();
    const users = (pl.users ?? {}) as Record<string, number>;
    return users[me] ?? ((pl.users_default as number) ?? 0);
  }

  /** Power level required to send the given state event, per the room's
   * `events` map, falling back to the supplied default when unspecified. */
  private stateEventLevel(type: string, fallback: number): number {
    const events = (this.powerLevels().events ?? {}) as Record<string, number>;
    return events[type] ?? fallback;
  }

  private canSet(type: string, fallback: number): boolean {
    return this.myPowerLevel() >= this.stateEventLevel(type, fallback);
  }

  /** This user's own effective power level (public accessor for menus). */
  myLevel(): number {
    return this.myPowerLevel();
  }

  /** Effective power level of the given user in this room. */
  powerLevelOf(userId: string): number {
    const users = (this.powerLevels().users ?? {}) as Record<string, number>;
    return users[userId] ?? ((this.powerLevels().users_default as number) ?? 0);
  }

  /** The room's default power level for members without an explicit entry. */
  defaultPowerLevel(): number {
    return (this.powerLevels().users_default as number) ?? 0;
  }

  /**
   * Whether the user may edit the room's power levels at all. Requires the
   * power to send the m.room.power_levels state event; the conventional
   * default required level, when unspecified, is 100. Per-target limits
   * (you cannot touch someone at or above your own level) are enforced in
   * {@link setPowerLevel}.
   */
  canChangePower(): boolean {
    return this.canSet(EventType.RoomPowerLevels, 100);
  }

  /**
   * Set a member's power level. Clones the m.room.power_levels content and
   * writes `users[userId] = level`, or deletes the entry when `level` equals
   * the room default so the member falls back cleanly. You may never set a
   * member at or above your own level, nor change a member who already sits
   * at or above it.
   */
  async setPowerLevel(userId: string, level: number): Promise<void> {
    if (!this.canChangePower()) throw toMaterixError(new Error("You cannot change power levels in this room."));
    const myLevel = this.myPowerLevel();
    if (level >= myLevel) throw toMaterixError(new Error("You cannot set a power level at or above your own."));
    const pl = this.powerLevels();
    const usersDefault = (pl.users_default as number) ?? 0;
    const users = { ...((pl.users as Record<string, number>) ?? {}) };
    const targetLevel = users[userId] ?? usersDefault;
    if (targetLevel >= myLevel)
      throw toMaterixError(new Error("You cannot change a member at or above your own power level."));
    if (level === usersDefault) delete users[userId];
    else users[userId] = level;
    try {
      await this.client.sendStateEvent(this.roomId, EventType.RoomPowerLevels, { ...pl, users }, "");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** True when the user may edit at least one room-settings field. */
  canEditRoom(): boolean {
    return (
      this.canSet(EventType.RoomName, 50) ||
      this.canSet(EventType.RoomTopic, 50) ||
      this.canSet(EventType.RoomAvatar, 50) ||
      this.canSet(EventType.RoomJoinRules, 100) ||
      this.canSet(EventType.RoomHistoryVisibility, 100) ||
      this.canSet(EventType.RoomGuestAccess, 100)
    );
  }

  details(): RoomDetails {
    const pl = this.powerLevels();
    const myPl = this.myPowerLevel();
    const inviteLevel = (pl.invite as number) ?? 0;
    const kickLevel = (pl.kick as number) ?? 50;
    const redactLevel = (pl.redact as number) ?? 50;
    const joinRule = (this.room.currentState
      .getStateEvents(EventType.RoomJoinRules, "")
      ?.getContent().join_rule as JoinRuleValue) ?? "invite";
    const historyVisibility = (this.room.currentState
      .getStateEvents(EventType.RoomHistoryVisibility, "")
      ?.getContent().history_visibility as HistoryVisibilityValue) ?? "shared";
    const guestAccess = ((this.room.currentState
      .getStateEvents(EventType.RoomGuestAccess, "")
      ?.getContent().guest_access as string) ?? "forbidden") as "can_join" | "forbidden";
    const canEditName = this.canSet(EventType.RoomName, 50);
    const canEditTopic = this.canSet(EventType.RoomTopic, 50);
    const canEditAvatar = this.canSet(EventType.RoomAvatar, 50);
    const canEditJoinRule = this.canSet(EventType.RoomJoinRules, 100);
    const canEditHistoryVisibility = this.canSet(EventType.RoomHistoryVisibility, 100);
    const canEditGuestAccess = this.canSet(EventType.RoomGuestAccess, 100);
    return {
      roomId: this.roomId,
      name: this.room.name,
      topic: (this.room.currentState.getStateEvents(EventType.RoomTopic, "")?.getContent().topic as string) ?? undefined,
      avatarUrl: this.room.getMxcAvatarUrl() ?? undefined,
      canonicalAlias: this.room.getCanonicalAlias() ?? undefined,
      isEncrypted: this.room.hasEncryptionStateEvent(),
      isDirect: !!this.client.getAccountData(EventType.Direct)?.getContent<Record<string, string[]>>(),
      memberCount: this.room.getJoinedMemberCount(),
      myPowerLevel: myPl,
      canInvite: myPl >= inviteLevel,
      canKick: myPl >= kickLevel,
      canRedactOthers: myPl >= redactLevel,
      joinRule,
      historyVisibility,
      guestAccess,
      canEditName,
      canEditTopic,
      canEditAvatar,
      canEditJoinRule,
      canEditHistoryVisibility,
      canEditGuestAccess,
      canEditRoom:
        canEditName ||
        canEditTopic ||
        canEditAvatar ||
        canEditJoinRule ||
        canEditHistoryVisibility ||
        canEditGuestAccess,
    };
  }

  // ---- room settings (state events, each power-level guarded) ----

  /** Rename the room (m.room.name). */
  async setRoomName(name: string): Promise<void> {
    if (!this.canSet(EventType.RoomName, 50)) throw toMaterixError(new Error("You cannot rename this room."));
    try {
      await this.client.sendStateEvent(this.roomId, EventType.RoomName, { name: name.trim() }, "");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Set the room topic (m.room.topic). */
  async setTopic(topic: string): Promise<void> {
    if (!this.canSet(EventType.RoomTopic, 50)) throw toMaterixError(new Error("You cannot change the topic."));
    try {
      await this.client.sendStateEvent(this.roomId, EventType.RoomTopic, { topic }, "");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Upload an image and set it as the room avatar (m.room.avatar). */
  async setRoomAvatar(file: File): Promise<void> {
    if (!this.canSet(EventType.RoomAvatar, 50)) throw toMaterixError(new Error("You cannot change the room avatar."));
    const mime = file.type || "image/png";
    const info: Record<string, unknown> = { mimetype: mime, size: file.size };
    try {
      const bmp = await createImageBitmap(file);
      info.w = bmp.width;
      info.h = bmp.height;
      bmp.close();
    } catch {
      // dimensions are optional
    }
    try {
      const upload = await this.client.uploadContent(file, { type: mime });
      await this.client.sendStateEvent(this.roomId, EventType.RoomAvatar, { url: upload.content_uri, info }, "");
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Set who may join the room (m.room.join_rules). */
  async setJoinRule(rule: "public" | "invite"): Promise<void> {
    if (!this.canSet(EventType.RoomJoinRules, 100)) throw toMaterixError(new Error("You cannot change the join rule."));
    try {
      await this.client.sendStateEvent(
        this.roomId,
        EventType.RoomJoinRules,
        { join_rule: rule === "public" ? JoinRule.Public : JoinRule.Invite },
        "",
      );
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Set history visibility for new members (m.room.history_visibility). */
  async setHistoryVisibility(visibility: HistoryVisibilityValue): Promise<void> {
    if (!this.canSet(EventType.RoomHistoryVisibility, 100))
      throw toMaterixError(new Error("You cannot change history visibility."));
    try {
      await this.client.sendStateEvent(
        this.roomId,
        EventType.RoomHistoryVisibility,
        { history_visibility: visibility as HistoryVisibility },
        "",
      );
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Toggle whether guest accounts may join (m.room.guest_access). */
  async setGuestAccess(allow: boolean): Promise<void> {
    if (!this.canSet(EventType.RoomGuestAccess, 100))
      throw toMaterixError(new Error("You cannot change guest access."));
    try {
      await this.client.sendStateEvent(
        this.roomId,
        EventType.RoomGuestAccess,
        { guest_access: allow ? GuestAccess.CanJoin : GuestAccess.Forbidden },
        "",
      );
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Collect image/video (and optionally file) events from loaded history. */
  media(kinds: ("image" | "video" | "file")[] = ["image", "video"]): MediaItem[] {
    const want = new Set(kinds);
    const out: MediaItem[] = [];
    for (const ev of this.room.getLiveTimeline().getEvents()) {
      if (ev.getType() !== EventType.RoomMessage || ev.isRedacted()) continue;
      const content = ev.getContent();
      const msgtype = content.msgtype as string;
      const kind = msgtype === "m.image" ? "image" : msgtype === "m.video" ? "video" : msgtype === "m.file" ? "file" : null;
      if (!kind || !want.has(kind)) continue;
      const info = (content.info ?? {}) as Record<string, unknown>;
      const file = content.file as EncryptedFileInfo | undefined;
      const mxc = (file?.url ?? content.url) as string | undefined;
      if (!mxc) continue;
      const thumbFile = info.thumbnail_file as EncryptedFileInfo | undefined;
      const member = this.room.getMember(ev.getSender() ?? "");
      out.push({
        eventId: ev.getId() ?? `${ev.getTs()}`,
        kind,
        ts: ev.getTs(),
        senderName: ev.getSender() === this.client.getUserId() ? "You" : (member?.name ?? ev.getSender() ?? ""),
        text: (content.body as string) ?? "",
        mxc,
        file,
        thumbMxc: (thumbFile?.url ?? info.thumbnail_url) as string | undefined,
        thumbFile,
        mime: info.mimetype as string | undefined,
        size: info.size as number | undefined,
        w: info.w as number | undefined,
        h: info.h as number | undefined,
      });
    }
    return out.reverse(); // newest first
  }

  /**
   * Case-insensitive substring search over ALREADY-LOADED, decrypted message
   * text — plain messages (m.text/notice/emote) and media captions. This does
   * NOT hit the homeserver search API, so it only covers the history currently
   * held in the timeline (widen it by paginating back first). Newest first.
   * Pure and allocation-cheap: one pass over the live timeline.
   */
  searchMessages(query: string): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const out: SearchHit[] = [];
    for (const ev of this.room.getLiveTimeline().getEvents()) {
      if (ev.getType() !== EventType.RoomMessage) continue;
      if (ev.isRedacted() || ev.isDecryptionFailure() || ev.isBeingDecrypted()) continue;
      const content = ev.getContent();
      // Edits render through their target, not standalone — skip the replacement.
      if (content["m.relates_to"]?.rel_type === "m.replace") continue;
      const text = searchableText(content);
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      const eventId = ev.getId();
      if (!eventId) continue;
      out.push({
        eventId,
        senderName: this.senderOf(ev).name,
        ts: ev.getTs(),
        snippet: snippetAround(text, idx, needle.length),
      });
    }
    return out.reverse(); // newest first
  }

  /**
   * Full-history search via the homeserver's `/search` API, scoped to THIS
   * room. Unlike {@link searchMessages}, which only sees the events already in
   * the timeline, this hits the server's full-text index and can match
   * messages that were never paginated in. Results are mapped to the same
   * {@link SearchHit} shape so the UI renders local and server hits
   * identically; newest first.
   *
   * Search is optional in the Matrix spec: homeservers without a full-text
   * index (or with search disabled) answer `M_UNRECOGNIZED` / 404 / 501 for
   * this endpoint. That case is surfaced as a clear UNSUPPORTED_SERVER error so
   * the UI can tell the user rather than showing an empty result set.
   */
  async searchServer(query: string): Promise<SearchHit[]> {
    const term = query.trim();
    if (!term) return [];
    let res;
    try {
      res = await this.client.searchRoomEvents({
        term,
        filter: { rooms: [this.roomId], types: [EventType.RoomMessage] },
      });
    } catch (e) {
      const err = (e ?? {}) as { errcode?: string; data?: { errcode?: string }; httpStatus?: number };
      const errcode = err.errcode ?? err.data?.errcode;
      if (errcode === "M_UNRECOGNIZED" || err.httpStatus === 404 || err.httpStatus === 501) {
        throw new MaterixError(
          "UNSUPPORTED_SERVER",
          "This homeserver doesn't support full-history search.",
          false,
          e,
        );
      }
      throw toMaterixError(e);
    }

    const needle = term.toLowerCase();
    const out: SearchHit[] = [];
    for (const r of res.results) {
      const ev = r.context.getEvent();
      const eventId = ev.getId();
      if (!eventId) continue;
      if (ev.isRedacted() || ev.isDecryptionFailure() || ev.isBeingDecrypted()) continue;
      const content = ev.getContent();
      // Edits render through their target, not standalone — skip the replacement.
      if (content["m.relates_to"]?.rel_type === "m.replace") continue;
      // Prefer the searchable text (plain body / media caption); fall back to
      // the raw body so a hit that matched only in formatted HTML still shows.
      const text = searchableText(content) || stripReplyFallbackText((content.body as string) ?? "");
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(needle);
      out.push({
        eventId,
        senderName: this.senderOf(ev).name,
        ts: ev.getTs(),
        snippet: idx === -1 ? text.replace(/\s+/g, " ").trim().slice(0, 120) : snippetAround(text, idx, needle.length),
      });
    }
    // Homeserver order_by defaults to relevance; present newest-first to match
    // the local search so the scope toggle feels consistent.
    return out.sort((a, b) => b.ts - a.ts);
  }

  /** Currently-live location beacons in this room (yours and others'). */
  liveBeacons(): LiveBeacon[] {
    const me = this.client.getUserId();
    const out: LiveBeacon[] = [];
    for (const beacon of this.room.currentState.beacons.values()) {
      if (!beacon.isLive) continue;
      const info = beacon.beaconInfo;
      const owner = beacon.beaconInfoOwner;
      const member = this.room.getMember(owner);
      let lat: number | undefined;
      let lon: number | undefined;
      let accuracy: number | undefined;
      const loc = beacon.latestLocationState;
      if (loc?.uri) {
        const parsed = parseBeaconContent({ "org.matrix.msc3672.beacon": { "m.location": { uri: loc.uri } } } as never);
        const uri = parsed.uri ?? loc.uri;
        const m = /geo:([-\d.]+),([-\d.]+)(?:;u=([\d.]+))?/.exec(uri);
        if (m) {
          lat = parseFloat(m[1]);
          lon = parseFloat(m[2]);
          accuracy = m[3] ? parseFloat(m[3]) : undefined;
        }
      }
      const startTs = info.timestamp ?? beacon.beaconInfo.timestamp ?? Date.now();
      out.push({
        id: beacon.identifier,
        owner: { userId: owner, name: member?.name ?? owner, avatarUrl: member?.getMxcAvatarUrl() ?? undefined },
        mine: owner === me,
        description: info.description,
        lat,
        lon,
        accuracy,
        updatedTs: loc?.timestamp,
        expiresTs: startTs + (info.timeout ?? 0),
      });
    }
    return out.sort((a, b) => Number(b.mine) - Number(a.mine) || (b.updatedTs ?? 0) - (a.updatedTs ?? 0));
  }

  members(): MemberSummary[] {
    const pl = this.room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
    const users = (pl.users ?? {}) as Record<string, number>;
    return this.room
      .getJoinedMembers()
      .map((m) => ({
        userId: m.userId,
        name: m.name,
        avatarUrl: m.getMxcAvatarUrl() ?? undefined,
        powerLevel: users[m.userId] ?? ((pl.users_default as number) ?? 0),
        membership: m.membership ?? "join",
      }))
      .sort((a, b) => b.powerLevel - a.powerLevel || a.name.localeCompare(b.name));
  }

  typingNames(): string[] {
    const me = this.client.getUserId();
    return this.room
      .getMembers()
      .filter((m) => m.typing && m.userId !== me)
      .map((m) => m.name);
  }

  async invite(userId: string): Promise<void> {
    try {
      await this.client.invite(this.roomId, userId);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async kick(userId: string, reason?: string): Promise<void> {
    try {
      await this.client.kick(this.roomId, userId, reason);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Report an event to the homeserver's moderators. Score −100 (most severe). */
  async report(eventId: string, reason: string): Promise<void> {
    try {
      await this.client.reportEvent(this.roomId, eventId, -100, reason);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async ban(userId: string, reason?: string): Promise<void> {
    try {
      await this.client.ban(this.roomId, userId, reason);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  async unban(userId: string): Promise<void> {
    try {
      await this.client.unban(this.roomId, userId);
    } catch (e) {
      throw toMaterixError(e);
    }
  }

  /** Whether the current user's power level meets the room's ban requirement. */
  canBan(): boolean {
    const me = this.client.getUserId()!;
    const pl = this.room.currentState.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() ?? {};
    const users = (pl.users ?? {}) as Record<string, number>;
    const myPl = users[me] ?? ((pl.users_default as number) ?? 0);
    const banLevel = (pl.ban as number) ?? 50;
    return myPl >= banLevel;
  }

  async leave(): Promise<void> {
    try {
      await this.client.leave(this.roomId);
    } catch (e) {
      throw toMaterixError(e);
    }
  }
}
