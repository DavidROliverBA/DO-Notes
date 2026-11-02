// What the web clipper sends to DO Notes (F37): the same form the iPhone's share sheet sends to
// POST /api/capture (src/capture.ts), so the server treats every way in alike. A page becomes a
// Weblink note; a selection is kept as a quote with its page linked; a picture is saved as a
// photo. The token goes only in the Authorization header.

/** Markdown-safe link text. */
const label = (s) => String(s ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();

/** A selection as a quote under its source: "> words…" then "— [Title](url)". */
export function quoteFor(selection, title, url) {
  const words = String(selection).trim().slice(0, 15_000);
  const quoted = words.split(/\r?\n/).map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
  return `${quoted}\n— [${label(title) || url}](${url})`;
}

/** The form for one clip: { kind: "page" | "selection" | "image", url, title, selection?, image? }. */
export function formFor(clip) {
  const form = new FormData();
  if (clip.kind === "image" && clip.image) {
    form.append("photo", clip.image, clip.imageName || "Picture");
  } else if (clip.kind === "selection" && clip.selection?.trim()) {
    form.append("item", quoteFor(clip.selection, clip.title, clip.url));
  } else {
    form.append("item", clip.url);
    form.append("url", clip.url);
    if (clip.title) form.append("title", label(clip.title));
  }
  return form;
}

/** Send a clip; the server's words ("Saved it to Inbox") or a plain reason it wasn't saved. */
export async function send(settings, clip, fetcher = fetch) {
  if (!settings?.server || !settings?.token) return { ok: false, message: "Set up the clipper first: its options need your DO Notes address and a capture token." };
  let res;
  try {
    res = await fetcher(new URL("/api/capture", settings.server), {
      method: "POST",
      headers: { authorization: `Bearer ${settings.token}`, accept: "application/json" },
      body: formFor(clip),
    });
  } catch {
    return { ok: false, message: "Couldn't reach DO Notes, so nothing was saved." };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, message: body.message || "Saved" };
  if (res.status === 401 || res.status === 403) return { ok: false, message: "DO Notes refused the token: make a new one in Settings → Connections." };
  return { ok: false, message: body.error || `DO Notes couldn't save it (error ${res.status}).` };
}
