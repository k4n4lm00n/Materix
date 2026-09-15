import { describe, it, expect, beforeEach } from "vitest";
import {
  createGroupingState,
  reduceIncoming,
  reduceRoomViewed,
  formatLine,
  MAX_ROOM_LINES,
  MAX_ACCOUNT_LINES,
  type GroupingState,
  type IncomingMessage,
} from "./notifyGrouping";

// reduceIncoming / reduceRoomViewed are the pure state machine behind Android's
// grouped notifications: JS accumulates the "since last viewed" tally and the
// Kotlin side just renders whatever payload comes out. Being pure, they are
// table-testable without a DOM or the Matrix SDK.

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  accountKey: "acctA",
  accountLabel: "@me:hs",
  roomId: "!room1:hs",
  roomName: "General",
  sender: "alice",
  body: "hello",
  title: "alice · General",
  mode: "preview",
  ...over,
});

describe("formatLine — privacy modes", () => {
  it("preview shows sender: body", () => {
    expect(formatLine("alice", "hi there", "preview")).toBe("alice: hi there");
  });
  it("name shows the sender only, never content", () => {
    expect(formatLine("alice", "secret text", "name")).toBe("alice");
  });
});

describe("reduceIncoming — count accumulation", () => {
  let state: GroupingState;
  beforeEach(() => {
    state = createGroupingState();
  });

  it("increments room and account counts per message", () => {
    reduceIncoming(state, msg());
    reduceIncoming(state, msg());
    const { payload } = reduceIncoming(state, msg());
    expect(payload.roomCount).toBe(3);
    expect(payload.totalCount).toBe(3);
    expect(payload.roomLines).toEqual(["alice: hello", "alice: hello", "alice: hello"]);
  });

  it("sums counts across rooms for the account total", () => {
    reduceIncoming(state, msg({ roomId: "!r1:hs" }));
    reduceIncoming(state, msg({ roomId: "!r1:hs" }));
    const { payload } = reduceIncoming(state, msg({ roomId: "!r2:hs", roomName: "Random" }));
    expect(payload.roomId).toBe("!r2:hs");
    expect(payload.roomCount).toBe(1);
    expect(payload.totalCount).toBe(3);
  });

  it("carries through title, body and channelId", () => {
    const { payload } = reduceIncoming(
      state,
      msg({ title: "T", body: "B", channelId: "acct.acctA" }),
    );
    expect(payload.title).toBe("T");
    expect(payload.body).toBe("B");
    expect(payload.channelId).toBe("acct.acctA");
  });

  it("omits channelId when the caller resolved none", () => {
    const { payload } = reduceIncoming(state, msg({ channelId: undefined }));
    expect("channelId" in payload).toBe(false);
  });
});

describe("reduceIncoming — line capping", () => {
  it("keeps only the last MAX_ROOM_LINES per room", () => {
    const state = createGroupingState();
    let payload;
    for (let i = 0; i < MAX_ROOM_LINES + 3; i++) {
      payload = reduceIncoming(state, msg({ body: `m${i}` })).payload;
    }
    expect(payload!.roomLines).toHaveLength(MAX_ROOM_LINES);
    // the earliest lines fall off; the newest survives
    expect(payload!.roomLines[MAX_ROOM_LINES - 1]).toBe(`alice: m${MAX_ROOM_LINES + 2}`);
    expect(payload!.roomLines[0]).toBe("alice: m3");
    // but the running count is not capped
    expect(payload!.roomCount).toBe(MAX_ROOM_LINES + 3);
  });

  it("caps summary lines at MAX_ACCOUNT_LINES across rooms", () => {
    const state = createGroupingState();
    let payload;
    for (let i = 0; i < MAX_ACCOUNT_LINES + 4; i++) {
      const roomId = `!r${i % 3}:hs`;
      payload = reduceIncoming(state, msg({ roomId, body: `m${i}` })).payload;
    }
    expect(payload!.accountLines).toHaveLength(MAX_ACCOUNT_LINES);
    expect(payload!.totalCount).toBe(MAX_ACCOUNT_LINES + 4);
  });
});

describe("reduceIncoming — privacy modes in the payload", () => {
  it("preview embeds the body in the lines", () => {
    const state = createGroupingState();
    const { payload } = reduceIncoming(state, msg({ mode: "preview", body: "the text" }));
    expect(payload.roomLines).toEqual(["alice: the text"]);
    expect(payload.accountLines).toEqual(["alice: the text"]);
  });

  it("name mode never puts content in any line", () => {
    const state = createGroupingState();
    const { payload } = reduceIncoming(
      state,
      msg({ mode: "name", sender: "bob", body: "New message" }),
    );
    expect(payload.roomLines).toEqual(["bob"]);
    expect(payload.accountLines).toEqual(["bob"]);
  });
});

describe("reduceRoomViewed — clear-on-view remainder math", () => {
  it("removes the viewed room and recomputes the remainder", () => {
    const state = createGroupingState();
    // room1: 3 messages, room2: 2 messages → total 5
    reduceIncoming(state, msg({ roomId: "!r1:hs", body: "a" }));
    reduceIncoming(state, msg({ roomId: "!r1:hs", body: "b" }));
    reduceIncoming(state, msg({ roomId: "!r1:hs", body: "c" }));
    reduceIncoming(state, msg({ roomId: "!r2:hs", roomName: "Two", sender: "bob", body: "d" }));
    reduceIncoming(state, msg({ roomId: "!r2:hs", roomName: "Two", sender: "bob", body: "e" }));

    const { clear } = reduceRoomViewed(state, "acctA", "!r1:hs");
    expect(clear).not.toBeNull();
    expect(clear!.remainingTotal).toBe(2);
    // Regression guard (on-device finding): the summary badge count the Kotlin
    // renderer reads is `totalCount` — it must mirror the remainder on a
    // clear-on-open re-post, else the summary shows "0 new messages".
    expect(clear!.totalCount).toBe(2);
    expect(clear!.totalCount).toBe(clear!.remainingTotal);
    // only room2's lines remain in the summary
    expect(clear!.accountLines).toEqual(["bob: d", "bob: e"]);
    expect(clear!.accountLabel).toBe("@me:hs");

    // a later message in room1 starts its count over
    const { payload } = reduceIncoming(state, msg({ roomId: "!r1:hs", body: "f" }));
    expect(payload.roomCount).toBe(1);
    expect(payload.totalCount).toBe(3);
  });

  it("signals summary removal when the last room is viewed", () => {
    const state = createGroupingState();
    reduceIncoming(state, msg({ roomId: "!only:hs" }));
    const { clear } = reduceRoomViewed(state, "acctA", "!only:hs");
    expect(clear!.remainingTotal).toBe(0);
    expect(clear!.accountLines).toEqual([]);
    // account fully drained
    expect(state.has("acctA")).toBe(false);
  });

  it("returns null when nothing is tracked for the room", () => {
    const state = createGroupingState();
    expect(reduceRoomViewed(state, "acctA", "!ghost:hs").clear).toBeNull();
    reduceIncoming(state, msg({ roomId: "!r1:hs" }));
    expect(reduceRoomViewed(state, "acctA", "!other:hs").clear).toBeNull();
  });
});

describe("multi-account isolation", () => {
  it("keeps per-account tallies independent", () => {
    const state = createGroupingState();
    reduceIncoming(state, msg({ accountKey: "acctA", roomId: "!r:hs" }));
    reduceIncoming(state, msg({ accountKey: "acctA", roomId: "!r:hs" }));
    const b = reduceIncoming(
      state,
      msg({ accountKey: "acctB", accountLabel: "@other:hs", roomId: "!r:hs" }),
    ).payload;
    // account B sees only its own single message
    expect(b.totalCount).toBe(1);
    expect(b.accountLabel).toBe("@other:hs");

    // clearing B's room leaves A untouched
    reduceRoomViewed(state, "acctB", "!r:hs");
    const a = reduceIncoming(state, msg({ accountKey: "acctA", roomId: "!r:hs" })).payload;
    expect(a.totalCount).toBe(3);
  });
});
