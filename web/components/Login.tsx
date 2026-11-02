// Sign in, or create an account. On a fresh server (needsSetup) it opens on "create account" and
// the first account becomes the admin; SETUP_TOKEN, when the server sets one, must be typed too.
// Signing in can also be with a passkey (F32): the button, or the email box's suggestions. With
// two-step sign-in on (F40), a right password asks next for the code app's code (or a recovery
// code).

import { useEffect, useState } from "react";
import { api, type Session } from "../lib/api";
import { passkeysSupported, prepareSignIn, signInWithPasskey, stopWaiting } from "../lib/passkeys";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/overlays";

export function Login({ session, onDone }: { session: Session; onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register">(session.needsSetup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // After a right password, when the account has two-step sign-in: the waiting sign-in's id.
  const [codeFlow, setCodeFlow] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const canPasskey = mode === "login" && !session.needsSetup && passkeysSupported();
  // Passkeys offered in the email box's suggestions, waiting quietly until one is chosen.
  useEffect(() => {
    if (!canPasskey) return;
    prepareSignIn();
    const t = setInterval(prepareSignIn, 3 * 60_000); // kept fresh while the page is open
    signInWithPasskey(true).then((u) => u && onDone(), (err) => setError((err as Error).message));
    return () => (clearInterval(t), stopWaiting());
  }, [canPasskey]);

  async function passkey() {
    setBusy(true);
    setError(null);
    try {
      if (await signInWithPasskey()) onDone();
    } catch (err) {
      setError((err as Error).message);
      prepareSignIn(); // ready for another go
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    stopWaiting();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ twoStep?: boolean; flow?: string }>(mode === "login" ? "/login" : "/register", { body: { email, password, name, ...(session.setupTokenRequired ? { setupToken } : {}) } });
      if (r.twoStep && r.flow) {
        setCodeFlow(r.flow);
        setCode("");
        return;
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ recoveryLeft?: number }>("/login/code", { body: { flow: codeFlow, code } });
      if (r.recoveryLeft !== undefined)
        toast(r.recoveryLeft > 0 ? `Signed in with a recovery code. ${r.recoveryLeft} left; make new ones in Settings → Account.` : "That was your last recovery code. Make new ones in Settings → Account.");
      onDone();
    } catch (err) {
      setError((err as Error).message);
      // Too many tries, or too slow: back to the password.
      if (/Sign in again/.test((err as Error).message)) setCodeFlow(null);
    } finally {
      setBusy(false);
    }
  }

  if (codeFlow)
    return (
      <div className="login">
        <form className="login-card" onSubmit={submitCode}>
          <div className="brand">
            <img src="/icon.svg" alt="" width="44" height="44" />
            <h1>DO Notes</h1>
          </div>
          <p>Enter the 6-digit code from your code app.</p>
          {error && <div className="error">{error}</div>}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123 456"
            aria-label="Code"
            autoComplete="one-time-code"
            inputMode="text"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={20}
            required
            autoFocus
          />
          <button className="primary" type="submit" disabled={busy || !code.trim()}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <p className="muted small">Lost your phone? Type one of your recovery codes instead.</p>
          <button type="button" className="link" onClick={() => (setCodeFlow(null), setError(null))}>
            Back
          </button>
        </form>
      </div>
    );

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h1>DO Notes</h1>
        </div>
        {session.needsSetup && <p className="notice">Welcome. The first account you create is the admin.</p>}
        {location.pathname === "/oauth/authorize" && !session.needsSetup && <p className="notice">Sign in to connect an app to your notes.</p>}
        {error && <div className="error">{error}</div>}
        {mode === "register" && <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete={canPasskey ? "username webauthn" : "email"} required autoFocus />
        <input
          type="password"
          placeholder={mode === "register" ? "Password (8+ characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          minLength={mode === "register" ? 8 : undefined}
          required
        />
        {session.setupTokenRequired && (
          <input
            type="password"
            placeholder="Setup token (SETUP_TOKEN on the server)"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
            required
          />
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? (mode === "login" ? "Signing in…" : "Creating account…") : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {canPasskey && (
          <button type="button" className="passkey-button" onClick={() => void passkey()} disabled={busy}>
            <Icon name="key" size={16} /> Sign in with a passkey
          </button>
        )}
        {!session.needsSetup && session.allowSignup && (
          <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
        )}
        {!session.allowSignup && mode === "login" && <p className="muted small">Accounts are invite-only — ask an admin.</p>}
      </form>
    </div>
  );
}
