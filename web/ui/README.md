# web/ui — the shared pieces

Everything that floats over the app, or appears on more than one screen, comes from here, so it
looks and behaves the same everywhere ([PRINCIPLES.md](../../docs/PRINCIPLES.md) §2). Styles for
these live in `web/styles/overlays.css`.

| Piece | Use it for | Notes |
|---|---|---|
| `Modal` | Any dialog or settings screen | Centred on a laptop, a bottom sheet on a phone. `size`: `small`, `normal`, `wide`. Escape and a click outside close only the top one; focus returns to where it was. |
| `Menu` | Any "⋯" or action list | A popover on a laptop, an action sheet with Cancel on a phone. Items: `label`, `icon`, `onSelect` or `href`, `danger`, `hidden`. |
| `confirmDialog()` | Only for things that **can't** be undone | The action is a verb ("Delete forever"); with `danger`, Cancel has focus, so Enter alone doesn't destroy anything. |
| `promptDialog()` | Asking for a name or path | `mustMatch` makes someone type a name to confirm a delete. Resolves `null` when cancelled. |
| `chooseDialog()` | Picking one of a list (a folder, a type, a template) | A filter box over the options; resolves the chosen `value`, or `null` when cancelled. |
| `Combobox` | A labelled box that filters a list as you type, inside a screen | The ARIA combobox pattern: arrows, Enter, Escape; a screen reader hears the option it's on. `create` offers the typed text as something new. Used by the relationship builder. |
| `toast()` | Saying something happened | `undo` adds an Undo button: prefer doing the thing and offering Undo over asking first. |
| `toastError()` | Anything that failed | Shows the server's plain-words message. |
| `PanelToggle` | Showing and hiding a side panel | The ▯| button: `side` left (the file panel, ⌘\\) or right (links and outline, and the AI). On a phone the left one opens the drawer. |
| `PanelResizer` | Dragging a side panel's width | A separator on the panel's inner edge (drag, arrows, double-click resets); `usePanelWidths()` remembers both widths in this browser and keeps 360px for the note. Not shown on a phone. |
| `Diff` | Showing a change before or after it's made | Lines from `lineDiff()` (`web/lib/diff.ts`), + and −, unchanged runs folded. |
| `openLightbox()` | Showing a picture on its own | Plain DOM, so CodeMirror widgets can use it too; a click or Escape closes it. |
| `Icon` | Every icon | One stroke set, drawn inline; add new shapes to `PATHS`. |

Rules of thumb:

- Never `alert`, `confirm` or `prompt` (`test/design.test.ts` fails on them).
- An action that can be reversed gets a toast with Undo, not a confirm.
- Buttons say what they do. Messages say what happened and what to do next.
