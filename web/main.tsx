// The client's entry point (loaded by web/index.html, bundled by Bun): fits the app to the iPhone's
// visual viewport, registers the service worker, and mounts App.

import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./lib/theme"; // the chosen theme, before the first paint of the app

// iOS Safari overlays the keyboard on the page instead of resizing it, which would hide the
// formatting bar and the cursor. Size the app to the visual viewport instead. Writing the height
// relays out the whole app, so it's written only when it changes, and not while keys are going
// down: then it waits until typing pauses, longer than iOS's wait before a held key starts
// repeating (about half a second), since the first press can itself change the height (the
// suggestions bar). The keyboard opening or closing has no keys in it, so that's immediate.
const vv = window.visualViewport;
if (vv) {
  let height = "";
  let lastKey = 0;
  let later: ReturnType<typeof setTimeout> | undefined;
  const PAUSE_MS = 1000;
  const setHeight = () => {
    const h = `${Math.round(vv.height)}px`;
    if (h === height) return;
    height = h;
    document.documentElement.style.setProperty("--vvh", h);
    // The keyboard is up when it takes a good part of the screen (the suggestions bar alone
    // doesn't). It then covers the home indicator, so the formatting bar drops the room it keeps
    // for it (styles/format-bar.css), which otherwise showed as an empty second row (N16).
    document.documentElement.classList.toggle("keyboard-up", window.innerHeight - vv.height > 120);
    clearOfKeyboardBar();
  };
  // iOS keeps a focused box above the keyboard, but not above the ˄ ˅ ✓ bar it floats over the
  // page (which no page can hide), and pinning the app to the visual viewport stops iOS
  // scrolling it anyway. So a box being typed in is scrolled into view with room under it for
  // the bar (scroll-margin-bottom in styles/phone.css). The editor isn't moved: CodeMirror keeps
  // its own cursor in view, above the formatting bar.
  const clearOfKeyboardBar = () => {
    const el = document.activeElement;
    if (!document.documentElement.classList.contains("keyboard-up") || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    requestAnimationFrame(() => {
      if (el.getBoundingClientRect().bottom > vv.height - parseFloat(getComputedStyle(el).scrollMarginBottom || "0")) el.scrollIntoView({ block: "nearest" });
    });
  };
  document.addEventListener("focusin", clearOfKeyboardBar);
  const fit = () => {
    clearTimeout(later);
    const since = performance.now() - lastKey;
    if (since < PAUSE_MS) later = setTimeout(() => fit(), PAUSE_MS - since);
    else setHeight();
    if (vv.offsetTop) window.scrollTo(0, 0);
  };
  window.addEventListener("keydown", () => (lastKey = performance.now()), { capture: true, passive: true });
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  fit();
}

// Offline (F4): a service worker keeps the app and what it needs to open, so the home-screen app
// starts with no signal. Not over plain http on another machine, where browsers don't allow it.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// A page brought back from the back/forward cache let go of its live streams when it was hidden
// (App.tsx), so start it afresh rather than show something that no longer updates.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) location.reload();
});

// No StrictMode: its double-mounted effects would open and tear down each note's live socket twice.
createRoot(document.getElementById("root")!).render(<App />);
