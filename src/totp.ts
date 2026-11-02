// The code app's codes (F40): TOTP, RFC 6238 (HMAC-SHA1 over 30-second steps, six digits), and
// the base32 keys code apps read. No server imports, so tests can use it directly.

import { createHmac } from "node:crypto";

export const STEP_S = 30;
export const DIGITS = 6;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The code for one 30-second step (HOTP over the step number). */
export function codeAt(secret: Uint8Array, step: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** digits).padStart(digits, "0");
}

/** The step a code matches, now or one either side (clocks drift), or null. */
export function matchStep(secret: Uint8Array, code: string, now = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const t = Math.floor(now / 1000 / STEP_S);
  for (const s of [t, t - 1, t + 1]) if (codeAt(secret, s) === c) return s;
  return null;
}

