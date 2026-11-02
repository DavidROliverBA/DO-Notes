// A software passkey for the tests (F32): makes and signs WebAuthn answers the way a phone or a
// Mac does (a P-256 key, "none" attestation, user present and verified), so the server's real
// checks run against them. Tests in the browser use Chrome's virtual authenticator instead.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

// Just enough CBOR (RFC 8949) for an attestation object and a COSE key.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported value");
}

export class FakeAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  counter = 0;
  userHandle: string | undefined;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  get id() {
    return b64url(this.credentialId);
  }

  private authData(rpId: string, withKey: boolean) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const flags = 0x01 | 0x04 | (withKey ? 0x40 : 0); // user present, user verified, (attested key)
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), count];
    if (withKey) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.cose);
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The answer to registration options (`navigator.credentials.create`), from `origin`. */
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", this.authData(rpId, true)]]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  /** The answer to sign-in options (`navigator.credentials.get`), from `origin`. */
  get(options: { challenge: string; rpId?: string }, origin: string) {
    this.counter++;
    const rpId = options.rpId ?? new URL(origin).hostname;
    const authenticatorData = this.authData(rpId, false);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.key);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authenticatorData), signature: b64url(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
    };
  }
}
