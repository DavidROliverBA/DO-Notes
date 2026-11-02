// Passkeys in the browser (F32; the server side is src/passkeys.ts): sign in with Face ID or
// Touch ID, and add one to the account. The browser (or the iPhone and Mac apps' web view) asks
// for the face or finger; nothing secret ever reaches Commonplace.

import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { api, type User } from "./api";

export const passkeysSupported = (): boolean => browserSupportsWebAuthn();

// Safari makes a passkey only straight after a tap: a request to the server between the tap and
// the ask can use that up, and the device then refuses as if cancelled. So the options are
// fetched before the tap (`prepare…`), and the tap goes straight to Face ID. The server keeps a
// challenge five minutes; one older than four is fetched again.
const FRESH_MS = 4 * 60_000;
type SignInOptions = { options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; flow: string };
type AddOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
let signInReady: { at: number; p: Promise<SignInOptions> } | null = null;
let addReady: { at: number; p: Promise<AddOptions> } | null = null;

const signInOptions = () => api<SignInOptions>("/passkeys/login/options", { method: "POST" });
const addOptions = () => api<AddOptions>("/passkeys/options", { method: "POST" });

/** Fetch sign-in options ahead of the button being pressed. */
export function prepareSignIn() {
  signInReady = { at: Date.now(), p: signInOptions() };
  signInReady.p.catch(() => (signInReady = null));
}

/** Fetch options for adding a passkey ahead of the button being pressed. */
export function prepareAdd() {
  addReady = { at: Date.now(), p: addOptions() };
  addReady.p.catch(() => (addReady = null));
}

function take<T>(ready: { at: number; p: Promise<T> } | null, fetch: () => Promise<T>): Promise<T> {
  return ready && Date.now() - ready.at < FRESH_MS ? ready.p : fetch();
}

/** Sign in with a passkey. With `autofill`, it waits quietly for the email box's suggestions
 *  (the passkey offered there) and returns null if that's never used. */
export async function signInWithPasskey(autofill = false): Promise<User | null> {
  if (autofill && !(await browserSupportsWebAuthnAutofill())) return null;
  let got: SignInOptions;
  if (autofill) got = await signInOptions();
  else {
    got = await take(signInReady, signInOptions);
    signInReady = null; // each set of options is good for one answer
  }
  const { options, flow } = got;
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  } catch (e) {
    // Cancelled (Escape, Cancel, or another sign-in took over): quiet for the email box's
    // suggestions; from the button, say so, since a device that refuses looks the same.
    if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError" || e.name === "SecurityError" || /cancel|abort/i.test(e.message))) {
      if (autofill || e.name === "AbortError") return null;
      throw new Error(`Signing in with a passkey didn't finish${e.message ? ` (${e.message})` : ""}. Try again, or sign in with your password.`);
    }
    throw e;
  }
  const { user } = await api<{ user: User }>("/passkeys/login", { body: { flow, response } });
  return user;
}

/** Prove it's you with a passkey, without signing in again: the answer goes with a change that
 *  needs it (setting a password on an account that signs in with passkeys only, F40). */
export async function confirmWithPasskey(): Promise<{ flow: string; response: unknown }> {
  const { options, flow } = await signInOptions();
  try {
    return { flow, response: await startAuthentication({ optionsJSON: options }) };
  } catch (e) {
    if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) throw new Error("No passkey was used, so nothing changed.");
    throw e;
  }
}

/** Stop a waiting autofill sign-in (leaving the page, or signing in another way). */
export const stopWaiting = () => WebAuthnAbortService.cancelCeremony();

export interface PasskeyRow {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** What the device said when no passkey came of it: cancelled by the person, or refused (an app
 *  its domain isn't confirmed for yet, or passkeys turned off). Browsers give both the same name,
 *  so the words say both. */
export class NoPasskey extends Error {
  constructor(detail: string) {
    super(`No passkey was made. If Face ID or Touch ID didn't ask, this device won't make one for DO Notes yet${detail ? ` (it said: ${detail})` : ""}. Try again in a minute; in the iPhone or Mac app, try Safari.`);
  }
}

/** Add a passkey on this device. Throws NoPasskey when the device didn't make one. */
export async function addPasskey(name: string): Promise<PasskeyRow> {
  const options = await take(addReady, addOptions);
  addReady = null;
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (e) {
    if (e instanceof Error && e.name === "InvalidStateError") throw new Error("This device has a passkey for your account already.");
    if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError" || e.name === "SecurityError")) throw new NoPasskey(e.message);
    throw e;
  }
  return api<PasskeyRow>("/passkeys", { body: { response, name } });
}

/** A name for a passkey made here, to tell them apart in Settings: "iPhone", "Mac", "Windows"… */
export function deviceName(ua = navigator.userAgent): string {
  if (/CommonplaceMac\//.test(ua)) return "Mac app";
  if (/CommonplaceApp\//.test(ua)) return /iPad/.test(ua) ? "iPad app" : "iPhone app";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? "iPad" : "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "This device";
}
