// The standalone build's entry point (standalone/build.ts): the app's styles, then the app.

import "../web/styles.css";
import "../web/lib/theme"; // the chosen theme, before the first paint
import "./standalone.css";
import { createRoot } from "react-dom/client";
import { keepInMemory } from "../web/lib/router";
import { App } from "./App";

// Opened from disk, the page can't put the app's paths in the address bar: they're kept in memory.
keepInMemory();

const vv = window.visualViewport;
if (vv) {
  const fit = () => document.documentElement.style.setProperty("--vvh", `${vv.height}px`);
  vv.addEventListener("resize", fit);
  fit();
}

createRoot(document.getElementById("root")!).render(<App />);
