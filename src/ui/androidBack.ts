// Android system Back handling. The native shell swallows EVERY hardware /
// gesture Back (an always-enabled OnBackPressedCallback injected by
// scripts/apply-android-push.sh — Materix is only ever closed from the app
// switcher) and forwards each press to the WebView as a window "android-back"
// event. Here that event walks an in-app priority ladder:
//
//   1. an open overlay (context menu, emoji picker, image lightbox, any
//      modal dialog) — close the top-most one;
//   2. the room-details panel — close it (App-level fallback);
//   3. a chat open on the narrow layout — go back to the room list;
//   4. nothing left to close (the room list is the top level) — move the
//      task to the BACKGROUND, Element-style: the home screen shows but the
//      activity and WebView stay alive, so the next launcher tap resumes
//      instantly. Never finish()/exit — only the app switcher closes Materix.
//
// Off Android nothing dispatches "android-back", so this is inert on desktop.

/** Returns true when it consumed the Back press. */
type AppBackHandler = () => boolean;

let appHandler: AppBackHandler | null = null;

/** The app shell registers its state-level fallback (details pane / narrow
 * chat). Returns an unregister function. */
export function setAppBackHandler(handler: AppBackHandler): () => void {
  appHandler = handler;
  return () => {
    if (appHandler === handler) appHandler = null;
  };
}

/** Close the top-most transient overlay, if any. Overlay state lives deep in
 * unrelated components, so this drives them the way a user would:
 * Escape for the keyboard-dismissable ones, a synthetic press for the rest. */
function closeTopOverlay(): boolean {
  // Context menu / emoji picker close on a window-level Escape listener.
  if (document.querySelector(".ctx-menu, .emoji-picker")) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return true;
  }
  // The image lightbox only closes on click.
  const lightbox = document.querySelector<HTMLElement>(".lightbox");
  if (lightbox) {
    lightbox.click();
    return true;
  }
  // Every modal (Modal component and the add-account onboarding overlay)
  // closes on a mousedown that targets its own backdrop.
  const backdrops = document.querySelectorAll<HTMLElement>(".modal-backdrop");
  const top = backdrops[backdrops.length - 1];
  if (top) {
    top.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return true;
  }
  return false;
}

/** Background the task via the native bridge (MaterixPush.kt), keeping the
 * activity + WebView alive. Missing bridge/method (older native shell, or a
 * non-Android build that somehow dispatched the event) degrades to the old
 * stay-put behaviour — still never an exit. */
function moveTaskToBack(): void {
  const bridge = (window as unknown as { MaterixPushNative?: { moveTaskToBack?: () => void } })
    .MaterixPushNative;
  try {
    bridge?.moveTaskToBack?.();
  } catch {
    // stay in the foreground
  }
}

let wired = false;

/** Idempotent; called once from App. */
export function initAndroidBack() {
  if (wired) return;
  wired = true;
  window.addEventListener("android-back", () => {
    if (closeTopOverlay()) return;
    // App-level fallback; returning false means there is nothing left to go
    // back from — background the app (never close it).
    if (appHandler?.()) return;
    moveTaskToBack();
  });
}
