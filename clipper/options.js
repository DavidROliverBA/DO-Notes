// The clipper's options (F37): the DO Notes address and a capture token, kept in the extension's
// own storage. Saving asks the browser for permission to reach that address, and nothing else.

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const stored = await api.storage.local.get(["server", "token"]);
$("server").value = stored.server ?? "";
$("token").value = stored.token ?? "";

$("form").onsubmit = async (e) => {
  e.preventDefault();
  let origin;
  try {
    origin = new URL($("server").value.trim()).origin;
  } catch {
    $("status").textContent = "That isn't a web address.";
    return;
  }
  const granted = await api.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  if (!granted) {
    $("status").textContent = `The clipper needs permission to reach ${origin}.`;
    return;
  }
  await api.storage.local.set({ server: origin, token: $("token").value.trim() });
  $("status").textContent = "Saved. Click DO Notes in the toolbar, or right-click, to save to your Inbox.";
};

$("forget").onclick = async () => {
  await api.storage.local.remove(["server", "token"]);
  $("server").value = $("token").value = "";
  $("status").textContent = "Forgotten.";
};
