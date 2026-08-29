// Message composer: auto-growing textarea, Enter to send, Shift+Enter newline,
// markdown support, attachments (button, paste, drop), reply/edit modes,
// typing notifications.

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import type { RoomHandle } from "../core/roomHandle";
import type { TimelineItem } from "../core/types";
import {
  IconSend,
  IconSmile,
  IconX,
  IconEdit,
  IconReply,
  IconPlus,
  IconFile,
  IconLocation,
  IconChat,
  IconMic,
} from "./components/Icons";
import { EmojiPicker } from "./components/EmojiPicker";
import { ContextMenu, type MenuState } from "./components/ContextMenu";
import { PollDialog } from "./dialogs/PollDialog";
import { LocationDialog } from "./dialogs/LocationDialog";
import { VoiceRecorder } from "./components/VoiceRecorder";
import { ImageEditor } from "./components/ImageEditor";
import { useToast } from "./components/Toast";

export interface ComposeMode {
  kind: "reply" | "edit";
  item: TimelineItem;
}

export function Composer({
  handle,
  accountKey,
  mode,
  onClearMode,
  dropFilesRef,
}: {
  handle: RoomHandle;
  accountKey: string;
  mode: ComposeMode | null;
  onClearMode: () => void;
  /** ChatPane fills this so a drop anywhere in the chat routes through the composer. */
  dropFilesRef?: React.MutableRefObject<((files: FileList | File[]) => void) | null>;
}) {
  const [text, setText] = useState("");
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const [emoji, setEmoji] = useState<{ x: number; y: number } | null>(null);
  const [attachMenu, setAttachMenu] = useState<MenuState | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [locationOpen, setLocationOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [imageQueue, setImageQueue] = useState<File[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingRef = useRef<{ active: boolean; timer?: ReturnType<typeof setTimeout> }>({ active: false });
  const { showError } = useToast();

  // Drafts per room; edit mode preloads the original text.
  useEffect(() => {
    setText(mode?.kind === "edit" ? (mode.item.body?.msgtype === "m.text" ? mode.item.body.text : "") : "");
    taRef.current?.focus();
  }, [mode, handle.roomId]);

  useEffect(() => {
    taRef.current?.focus();
    setText("");
    onClearMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle.roomId]);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
  };

  const setTyping = (active: boolean) => {
    const t = typingRef.current;
    if (t.timer) clearTimeout(t.timer);
    if (active) {
      if (!t.active) {
        t.active = true;
        void handle.setTyping(true);
      }
      t.timer = setTimeout(() => {
        t.active = false;
        void handle.setTyping(false);
      }, 8000);
    } else if (t.active) {
      t.active = false;
      void handle.setTyping(false);
    }
  };

  async function send() {
    const value = text.trim();
    if (!value) return;
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    setTyping(false);
    const currentMode = mode;
    try {
      if (currentMode?.kind === "edit") {
        // Never fall through to a plain send here: a failed edit must stay an
        // edit, or retrying would post the text as a new message.
        if (!currentMode.item.eventId) throw new Error("original message has no event id");
        await handle.edit(currentMode.item.eventId, value);
      } else {
        await handle.sendText(value, currentMode?.kind === "reply" ? currentMode.item.eventId : undefined);
      }
      // Only clear reply/edit mode once the send succeeded, so a transient
      // failure keeps the mode (and the restored text) for a retry.
      onClearMode();
    } catch (e) {
      showError(e);
      setText(value); // don't lose the user's message
    }
  }

  async function uploadOne(file: File, caption?: string) {
    setUpload({ name: file.name, pct: 0 });
    try {
      await handle.sendFile(
        file,
        (loaded, total) => setUpload({ name: file.name, pct: total ? Math.round((loaded / total) * 100) : 0 }),
        caption ? { caption } : undefined,
      );
    } catch (e) {
      showError(e);
    } finally {
      setUpload(null);
    }
  }

  async function sendFiles(files: FileList | File[]) {
    const list = Array.from(files);
    // Images go through the editor (censor / crop / metadata strip); other
    // files upload directly.
    const images = list.filter((f) => f.type.startsWith("image/"));
    const others = list.filter((f) => !f.type.startsWith("image/"));
    for (const file of others) await uploadOne(file);
    if (images.length) setImageQueue((q) => [...q, ...images]);
  }

  // Expose the send handler so ChatPane's whole-area drop zone can reach it.
  if (dropFilesRef) dropFilesRef.current = sendFiles;

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.items]
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void sendFiles(files);
    }
  };

  const openAttachMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAttachMenu({
      x: r.left,
      y: r.top - 8, // anchor above the button; menu grows upward
      up: true,
      items: [
        { label: "Photo or file", icon: <IconFile size={16} />, onClick: () => fileRef.current?.click() },
        { label: "Poll", icon: <IconChat size={16} />, onClick: () => setPollOpen(true) },
        { label: "Location", icon: <IconLocation size={16} />, onClick: () => setLocationOpen(true) },
      ],
    });
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        {mode && (
          <div className="composer-reply">
            {mode.kind === "reply" ? <IconReply size={14} /> : <IconEdit size={14} />}
            <span className="composer-reply-text">
              {mode.kind === "reply" ? (
                <>
                  Replying to <strong>{mode.item.sender.name}</strong>: {mode.item.body?.text?.slice(0, 80)}
                </>
              ) : (
                "Editing message"
              )}
            </span>
            <button className="icon-btn" onClick={onClearMode} aria-label="Cancel" style={{ width: 26, height: 26 }}>
              <IconX size={14} />
            </button>
          </div>
        )}
        {recording ? (
          <VoiceRecorder
            onCancel={() => setRecording(false)}
            onSend={async (file, durationMs, waveform) => {
              setRecording(false);
              try {
                await handle.sendVoiceMessage(file, durationMs, waveform);
              } catch (e) {
                showError(e);
              }
            }}
          />
        ) : (
          <div className="composer-main">
            <button
              className="icon-btn"
              onClick={openAttachMenu}
              title="Attach"
              aria-label="Attach"
              aria-haspopup="menu"
              disabled={!!upload}
            >
              <IconPlus size={20} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void sendFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="icon-btn"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setEmoji({ x: r.left, y: r.top - 270 });
              }}
              title="Emoji"
              aria-label="Insert emoji"
              aria-haspopup="dialog"
            >
              <IconSmile size={19} />
            </button>
            <textarea
              ref={taRef}
              rows={1}
              placeholder="Message"
              value={text}
              aria-label="Message"
              onChange={(e) => {
                setText(e.target.value);
                autoGrow();
                setTyping(!!e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
                if (e.key === "Escape" && mode) onClearMode();
              }}
              onPaste={onPaste}
            />
            {text.trim() ? (
              <button className="send-btn" onClick={() => void send()} aria-label="Send message">
                <IconSend size={18} />
              </button>
            ) : (
              <button
                className="icon-btn"
                onClick={() => setRecording(true)}
                title="Record voice message"
                aria-label="Record voice message"
              >
                <IconMic size={20} />
              </button>
            )}
          </div>
        )}
        {upload && (
          <div className="upload-progress">
            Uploading {upload.name}… {upload.pct}%
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${upload.pct}%` }} />
            </div>
          </div>
        )}
      </div>
      {emoji && (
        <EmojiPicker
          anchor={emoji}
          onClose={() => setEmoji(null)}
          onPick={(e) => {
            setText((t) => t + e);
            taRef.current?.focus();
          }}
        />
      )}
      {imageQueue[0] && (
        <ImageEditor
          key={imageQueue.length}
          file={imageQueue[0]}
          onCancel={() => setImageQueue((q) => q.slice(1))}
          onSend={async (processed, caption) => {
            setImageQueue((q) => q.slice(1));
            await uploadOne(processed, caption || undefined);
          }}
        />
      )}
      {attachMenu && <ContextMenu menu={attachMenu} onClose={() => setAttachMenu(null)} />}
      {pollOpen && <PollDialog handle={handle} onClose={() => setPollOpen(false)} />}
      {locationOpen && (
        <LocationDialog handle={handle} accountKey={accountKey} onClose={() => setLocationOpen(false)} />
      )}
    </div>
  );
}
