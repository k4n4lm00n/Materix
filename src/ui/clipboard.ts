// Clipboard writes that work on every platform we ship to.
//
// `navigator.clipboard` is unavailable or permission-blocked in the Android
// WebView (and any non-secure context), where its promise rejects and nothing
// is copied. Try, in order:
//   1. the Tauri clipboard-manager plugin (native, works in the WebView),
//   2. the async clipboard API,
//   3. a hidden textarea + document.execCommand("copy") (the WebView path).
// Resolves once one succeeds; rejects only if all fail, so callers can toast
// success/failure truthfully.

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function tauriWrite(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

function execCommandWrite(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but focusable; readonly avoids popping the keyboard on mobile.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    ta.remove();
    active?.focus?.();
  }
  if (!ok) throw new Error("execCommand copy failed");
}

export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    try {
      await tauriWrite(text);
      return;
    } catch {
      // plugin not registered on this platform/build — fall through
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // undefined off secure contexts, or permission denied — fall through
  }
  execCommandWrite(text);
}
