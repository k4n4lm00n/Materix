// Keeps the app shell aligned with the *visual* viewport so the message
// composer is never hidden behind the Android/iOS soft keyboard.
//
// On Android the soft keyboard does not shrink the layout viewport by default
// (it only shrinks the visual viewport), so a `height: 100%` shell keeps its
// full height and its bottom-anchored composer ends up behind the keyboard.
// (In the Android app, MainActivity additionally pads the WebView by the IME
// inset — see .github/workflows/android.yml — which shrinks the layout
// viewport too.) We track `window.visualViewport` and publish two CSS custom
// properties on <html> that the stylesheet consumes:
//
//   --app-h     usable height in px (the visual viewport height) — `.app` is
//               sized to this, so shrinking it lifts the composer into view.
//   --kb-inset  height currently covered by the keyboard at the bottom, in px
//               (0 when the keyboard is closed) — available for other bottom
//               anchored UI that wants to dodge the keyboard.
//
// Works whether or not the WebView is configured with `adjustResize` /
// `interactive-widget=resizes-content`, because the height is driven directly
// from the measured visual viewport rather than from any native resize.

export function installViewportTracking(): void {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let lastH = 0;

  // The keyboard shrinks the viewport AFTER the field was focused (the focus
  // scroll-into-view already ran against the taller pre-keyboard viewport), so
  // a field low in a scroll container can be left just behind the keyboard.
  // Re-scroll the focused field whenever the usable height actually changes —
  // never on plain scrolls, to avoid a scroll feedback loop.
  const keepFocusedVisible = () => {
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  };

  const apply = () => {
    // On Android (WebView padded by the native IME-inset listener) the LAYOUT
    // viewport shrinks with the keyboard, and the resize event can be
    // delivered before both metrics have settled — reading only vv.height at
    // event time can capture the stale pre-keyboard value, leaving the
    // composer behind the keyboard until some later reflow re-fires a
    // viewport event. Take the smallest credible height: with an overlay
    // keyboard (plain browsers) only vv.height shrinks, with a native resize
    // both do, and whichever updated first is the smaller one. The settle
    // passes below re-read after the animation so a stale small value (e.g.
    // while the keyboard closes) also converges.
    const h = Math.min(vv ? vv.height : Infinity, window.innerHeight);
    const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    root.style.setProperty("--app-h", `${Math.round(h)}px`);
    root.style.setProperty("--kb-inset", `${Math.round(covered)}px`);
    if (h !== lastH) {
      lastH = h;
      keepFocusedVisible();
    }
  };

  // Re-apply a few times after any trigger: keyboard show/hide animates over
  // ~300ms and Android WebView updates innerHeight / visualViewport at
  // slightly different moments, so a single event-time read can be stale.
  let settleTimers: number[] = [];
  const settle = () => {
    apply();
    for (const t of settleTimers) window.clearTimeout(t);
    requestAnimationFrame(apply);
    settleTimers = [100, 250, 500, 1000].map((ms) => window.setTimeout(apply, ms));
  };

  apply();

  if (vv) {
    vv.addEventListener("resize", settle);
    vv.addEventListener("scroll", apply);
  }
  // Fallbacks for environments without visualViewport and for rotation.
  window.addEventListener("resize", settle);
  window.addEventListener("orientationchange", settle);
  // Focusing/blurring an editable is what opens/closes the keyboard — make
  // sure we re-measure even if no viewport event reaches us at the right time.
  window.addEventListener("focusin", settle);
  window.addEventListener("focusout", settle);
}
