// A picture on its own, over everything (click a picture in a note). Plain DOM, so CodeMirror
// widgets can open it as well as React. A click anywhere or Escape closes it, and focus goes
// back to where it was. Styles in overlays.css.

export function openLightbox(src: string, alt = ""): void {
  if (document.querySelector(".lightbox")) return;
  const back = document.activeElement as HTMLElement | null;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", alt || "Picture");
  box.tabIndex = -1;
  const img = box.appendChild(document.createElement("img"));
  img.src = src;
  img.alt = alt;
  const close = box.appendChild(document.createElement("button"));
  close.type = "button";
  close.className = "lightbox-close";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  const done = () => {
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    back?.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  box.addEventListener("click", done);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
  close.focus();
}
