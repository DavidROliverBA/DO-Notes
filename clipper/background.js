// The clipper's worker (F37): the right-click menu (a page, a selection, a picture) and the
// toolbar popup's requests. Settings come from the options page, or in Safari from the DO Notes Mac
// app itself (its sign-in's capture token, through native messaging), so Safari needs no setup.

import { send } from "./clip.js";

const api = globalThis.browser ?? globalThis.chrome;

async function settings() {
  const stored = await api.storage.local.get(["server", "token"]);
  if (stored.server && stored.token) return stored;
  // Safari: ask the Mac app, which shares its token with this extension.
  try {
    const native = await api.runtime.sendNativeMessage("com.davidroliver.commonplace", { want: "capture" });
    if (native?.server && native?.token) return native;
  } catch {}
  return stored;
}

async function imageFile(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error("Couldn't fetch that picture");
  const blob = await res.blob();
  const name = decodeURIComponent(new URL(src).pathname.split("/").pop() || "Picture").slice(0, 80);
  return { image: blob, imageName: name };
}

export async function clip(c) {
  if (c.kind === "image" && c.src) {
    try {
      Object.assign(c, await imageFile(c.src));
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }
  return send(await settings(), c);
}

function tell(tabId, result) {
  api.action.setBadgeText({ text: result.ok ? "✓" : "!", tabId });
  api.action.setBadgeBackgroundColor({ color: result.ok ? "#1d6b3a" : "#b3261e", tabId });
  api.action.setTitle({ title: result.message, tabId });
  setTimeout(() => api.action.setBadgeText({ text: "", tabId }), 4000);
}

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({ id: "page", title: "Save page to DO Notes", contexts: ["page", "link"] });
  api.contextMenus.create({ id: "selection", title: "Save selection to DO Notes", contexts: ["selection"] });
  api.contextMenus.create({ id: "image", title: "Save picture to DO Notes", contexts: ["image"] });
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  const base = { url: info.linkUrl || tab?.url || info.pageUrl, title: info.linkUrl ? "" : tab?.title || "" };
  const c = info.menuItemId === "selection" ? { ...base, kind: "selection", selection: info.selectionText } : info.menuItemId === "image" ? { ...base, kind: "image", src: info.srcUrl } : { ...base, kind: "page" };
  tell(tab?.id, await clip(c));
});

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === "clip") {
    clip(msg.clip).then(reply);
    return true;
  }
  if (msg?.type === "settings") {
    settings().then((s) => reply({ ready: Boolean(s.server && s.token), server: s.server ?? "" }));
    return true;
  }
});
