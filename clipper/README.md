# DO Notes Clipper

A browser extension (Manifest V3) that saves the page, the selected words or a picture to the
Inbox in DO Notes, through the same `POST /api/capture` the iPhone's share sheet uses (F37). Plain
JavaScript, so it loads as it is: there's no build.

- **Safari:** the Mac app carries it (`ios/project.yml` → `SafariClipper`), and it asks the app
  for its capture token by native messaging (`ios/SafariClipper/`), so there's nothing to set.
- **Chrome:** Extensions → Developer mode → Load unpacked → this folder. Options: the DO Notes
  address and a capture token (Settings → Connections → Share from iPhone → Create token).
  Saving them asks Chrome for permission to reach that address, and only that one.

`clip.js` builds the form and sends it (`test/clipper.test.ts`); `background.js` is the
right-click menu and the popup's worker. The token is only ever sent in the Authorization
header. The capture route accepts other origins because it signs in by token alone
(`route(…, { tokenOnly: true })` in `src/api.ts`).
