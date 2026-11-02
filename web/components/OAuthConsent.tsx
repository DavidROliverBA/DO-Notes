// /oauth/authorize: an app (claude.ai, the Claude apps, another MCP client) asks to use your notes
// (F25, src/oauth.ts). Shown after sign-in, on its own like the sign-in page. Allow sends you
// back to the app with a one-time code; Don't allow sends you back with a refusal. A request the
// server can't trust (unknown app, an address it didn't register) is explained here instead.

import { useEffect, useState } from "react";
import { api, type Session } from "../lib/api";

type Ask = { name: string; returnsTo: string; readOnly: boolean; device?: boolean };

export function OAuthConsent({ session }: { session: Session }) {
  const request = Object.fromEntries(new URLSearchParams(location.search));
  const [ask, setAsk] = useState<Ask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Ask>(`/oauth/request${location.search}`).then(
      (a) => (setAsk(a), setReadOnly(a.readOnly)),
      (e) => setError((e as Error).message),
    );
  }, []);

  async function answer(allow: boolean) {
    setBusy(true);
    try {
      const { redirect } = await api<{ redirect: string }>("/oauth/approve", { body: { request, allow, readOnly } });
      location.assign(redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card consent">
        <div className="brand">
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h1>DO Notes</h1>
        </div>
        {error ? (
          <>
            <div className="error" role="alert">
              {error}
            </div>
            <a href="/">Go to your notes</a>
          </>
        ) : !ask ? (
          <p className="muted">Checking the request…</p>
        ) : ask.device ? (
          <>
            <h2>
              Sign in <b>{ask.name}</b>?
            </h2>
            <p className="muted small">It returns to {ask.returnsTo}. Only sign in a Mac you've just connected yourself.</p>
            <p>
              DO Notes on that Mac will show your collections here beside its own, as {session.user!.name}, with your role in each: open and edit notes, live with
              everyone else, and move notes between the Mac and here.
            </p>
            <p className="muted small">You can sign it out at any time in Settings → Connections.</p>
            <div className="consent-actions">
              <button type="button" onClick={() => void answer(false)} disabled={busy}>
                Don't allow
              </button>
              <button type="button" className="primary" onClick={() => void answer(true)} disabled={busy} autoFocus>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>
              Let <b>{ask.name}</b> use your notes?
            </h2>
            <p className="muted small">It returns to {ask.returnsTo}. Only allow apps you've just added yourself.</p>
            <p>
              It can search and read your notes in every collection you can see{readOnly ? "" : ", and add and change notes where you're an editor"}, as{" "}
              {session.user!.name}. Changes are kept in each note's history, and nothing is deleted.
            </p>
            {!ask.readOnly && (
              <label className="check">
                <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read only
              </label>
            )}
            <p className="muted small">You can disconnect it at any time in Settings → Connections.</p>
            <div className="consent-actions">
              <button type="button" onClick={() => void answer(false)} disabled={busy}>
                Don't allow
              </button>
              <button type="button" className="primary" onClick={() => void answer(true)} disabled={busy} autoFocus>
                {busy ? "Connecting…" : "Allow"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
