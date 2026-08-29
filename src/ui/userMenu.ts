// Shared "user actions" context-menu builder: message, verify, copy ID, kick.

import type { MatrixAccount } from "../core/account";
import { uiBus } from "./bus";
import { copyText } from "./clipboard";
import type { MenuItem } from "./components/ContextMenu";

/** Success-toast text for a completed power-level change. */
export function powerLevelMessage(name: string, level: number, defaultLevel: number): string {
  if (level === defaultLevel) return `${name}'s role was reset.`;
  if (level >= 100) return `${name} is now an admin.`;
  if (level >= 50) return `${name} is now a moderator.`;
  return `${name}'s power level is now ${level}.`;
}

export function buildUserMenu(
  account: MatrixAccount,
  userId: string,
  opts: {
    showError: (e: unknown) => void;
    show: (text: string) => void;
    /** The room the menu was opened from; verification reuses it when shared. */
    roomId?: string;
    canKick?: boolean;
    onKick?: () => void;
    /** Show "Ban from room" (caller supplies the room-scoped handler). */
    canBan?: boolean;
    onBan?: () => void;
    /** Show role actions (promote/demote). Caller supplies the levels so the
     * menu only offers changes that are actually permitted and meaningful. */
    canChangePower?: boolean;
    myLevel?: number;
    targetLevel?: number;
    defaultLevel?: number;
    onSetPower?: (level: number) => void;
  },
): MenuItem[] {
  const items: MenuItem[] = [];
  const me = account.info().userId;

  if (userId !== me) {
    items.push({
      label: "Send message",
      onClick: async () => {
        try {
          const roomId = await account.startDm(userId);
          uiBus.openRoom({ accountKey: account.key, roomId });
        } catch (e) {
          opts.showError(e);
        }
      },
    });
    items.push({
      label: "Verify user",
      onClick: async () => {
        try {
          // Verify in the room the menu was opened from when the target shares
          // it; only fall back to a DM (reused or new) otherwise. This avoids
          // spawning a fresh chat when verifying someone you're already with.
          const roomId =
            opts.roomId && account.isJoinedMember(opts.roomId, userId)
              ? opts.roomId
              : await account.startDm(userId);
          uiBus.openRoom({ accountKey: account.key, roomId });
          const flow = await account.crypto.startUserVerification(userId, roomId);
          uiBus.showFlow(flow);
        } catch (e) {
          opts.showError(e);
        }
      },
    });
  }
  items.push({
    label: "Copy user ID",
    onClick: () => {
      copyText(userId).then(() => opts.show("User ID copied."), opts.showError);
    },
  });
  if (userId !== me) {
    const ignored = account.ignoredUsers().includes(userId);
    items.push({
      label: ignored ? "Unignore user" : "Ignore user",
      danger: !ignored,
      onClick: async () => {
        try {
          await account.setIgnored(userId, !ignored);
          opts.show(ignored ? "User unignored." : "User ignored.");
        } catch (e) {
          opts.showError(e);
        }
      },
    });
  }
  if (opts.canKick && userId !== me && opts.onKick) {
    items.push({ label: "Remove from room", danger: true, onClick: opts.onKick });
  }
  if (opts.canBan && userId !== me && opts.onBan) {
    items.push({ label: "Ban from room", danger: true, onClick: opts.onBan });
  }
  // Role actions: only when we may edit power levels and the target sits below
  // us (we can never touch someone at or above our own level). Each option is
  // shown only when it would actually change the member's current level, and
  // only when the target level is itself below ours.
  if (
    opts.canChangePower &&
    userId !== me &&
    opts.onSetPower &&
    opts.myLevel !== undefined &&
    opts.targetLevel !== undefined &&
    opts.targetLevel < opts.myLevel
  ) {
    const { myLevel, targetLevel } = opts;
    const setPower = opts.onSetPower;
    const defaultLevel = opts.defaultLevel ?? 0;
    for (const role of [
      { label: "Make admin (100)", level: 100 },
      { label: "Make moderator (50)", level: 50 },
    ]) {
      if (role.level < myLevel && role.level !== targetLevel) {
        items.push({ label: role.label, onClick: () => setPower(role.level) });
      }
    }
    if (targetLevel !== defaultLevel && defaultLevel < myLevel) {
      items.push({ label: "Reset to default", danger: true, onClick: () => setPower(defaultLevel) });
    }
  }
  return items;
}
