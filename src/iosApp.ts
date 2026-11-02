// The iPhone app (ios/): Apple's apple-app-site-association file, which lets the app open this
// server's links (universal links) and lets iCloud Keychain fill its sign-in (web credentials).
// Served only when APPLE_APP_IDS names the app, so no other server claims it.

/** Links that stay in Safari: the API, published sites and sign-ins for other apps. */
const NOT_THE_APP = ["/api/*", "/p/*", "/oauth/*", "/.well-known/*", "/sw.js", "/sandbox/*"];

export function appSiteAssociation(appIds: string[]) {
  return {
    applinks: {
      details: [{ appIDs: appIds, components: [...NOT_THE_APP.map((p) => ({ "/": p, exclude: true })), { "/": "/*" }] }],
    },
    webcredentials: { apps: appIds },
  };
}
