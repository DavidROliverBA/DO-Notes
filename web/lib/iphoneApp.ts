// Commonplace's iPhone app (ios/) shows this web client in a web view and says so in its user
// agent. Screens that talk about the home-screen app or the Shortcut use this to say the right thing.

export const inIPhoneApp = (): boolean => /\bCommonplaceApp\//.test(navigator.userAgent);
