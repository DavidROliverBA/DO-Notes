// The toolbar button's popup (F37): save the page, or the words selected on it.

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const [tab] = await api.tabs.query({ active: true, currentWindow: true });
let selection = "";
try {
  const [r] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: () => String(getSelection() ?? "") });
  selection = (r?.result ?? "").trim();
} catch {
  // A page the browser won't let extensions read (its own pages, the store): the page alone.
}

const ready = await api.runtime.sendMessage({ type: "settings" });
if (!ready?.ready) {
  $("what").textContent = "Set up the clipper first: give it your DO Notes address and a capture token.";
  $("save").textContent = "Set up";
  $("save").onclick = () => api.runtime.openOptionsPage();
} else {
  $("what").textContent = `“${tab.title || tab.url}” goes to your Inbox.`;
  if (selection) {
    $("selection").hidden = false;
    $("selection").textContent = `Save selection (${selection.length > 40 ? selection.slice(0, 40) + "…" : selection})`;
  }
  const go = async (clip) => {
    $("save").disabled = $("selection").disabled = true;
    $("status").textContent = "Saving…";
    const r = await api.runtime.sendMessage({ type: "clip", clip });
    $("status").textContent = r.message;
    $("status").className = r.ok ? "ok" : "bad";
    if (r.ok) setTimeout(() => window.close(), 1200);
    else $("save").disabled = $("selection").disabled = false;
  };
  $("save").onclick = () => go({ kind: "page", url: tab.url, title: tab.title });
  $("selection").onclick = () => go({ kind: "selection", url: tab.url, title: tab.title, selection });
}
$("options").onclick = (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
};
