/**
 * Kalshi request signing + at-rest encryption of the private key.
 *
 * Verified against https://docs.kalshi.com/getting_started/quick_start_authenticated_requests :
 *  - message = timestamp(ms) + HTTP_METHOD + full path from API root (e.g. /trade-api/v2/portfolio/balance),
 *    WITHOUT the query string
 *  - RSA keys sign with RSA-PSS / SHA-256 / MGF1-SHA-256 / salt length = digest length (32)
 *  - Ed25519 keys sign the message directly
 *  - signature is base64
 */

export type KeyKind = "rsa" | "ed25519";

export interface SigningKey {
  kind: KeyKind;
  key: CryptoKey;
}

export interface KalshiCreds {
  keyId: string;
  pem: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([tag]), derLen(content.length), content);
}

/** WebCrypto only imports PKCS#8. Kalshi's downloaded RSA keys are usually PKCS#1 ("BEGIN RSA PRIVATE KEY"), so wrap them. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaAlgId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  return derWrap(0x30, concat(version, rsaAlgId, derWrap(0x04, pkcs1)));
}

function containsBytes(hay: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Parse a PEM into PKCS#8 DER + detected key kind. Throws plain-language errors. */
export function parsePrivateKeyPem(pemText: string): { kind: KeyKind; pkcs8: Uint8Array } {
  const text = pemText.trim();
  const m = text.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error("That does not look like a PEM private key (missing BEGIN/END lines).");
  const label = m[1];
  const der = b64decode(m[2].replace(/\s+/g, ""));
  if (label === "RSA PRIVATE KEY") return { kind: "rsa", pkcs8: pkcs1ToPkcs8(der) };
  if (label === "PRIVATE KEY") {
    // Ed25519 OID 1.3.101.112 = 06 03 2B 65 70
    return { kind: containsBytes(der, [0x06, 0x03, 0x2b, 0x65, 0x70]) ? "ed25519" : "rsa", pkcs8: der };
  }
  if (label === "ENCRYPTED PRIVATE KEY") throw new Error("Password-protected keys are not supported. Use the key file Kalshi gave you.");
  throw new Error(`Unsupported key type "${label}". Kalshi keys are RSA or Ed25519.`);
}

export async function importSigningKey(pem: string): Promise<SigningKey> {
  const { kind, pkcs8 } = parsePrivateKeyPem(pem);
  try {
    if (kind === "ed25519") {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      return { kind, key };
    }
    const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
    return { kind, key };
  } catch {
    throw new Error("Could not read that private key. Paste the full PEM exactly as Kalshi gave it.");
  }
}

export async function signMessage(sk: SigningKey, message: string): Promise<string> {
  const data = enc.encode(message);
  const sig =
    sk.kind === "ed25519"
      ? await crypto.subtle.sign({ name: "Ed25519" }, sk.key, data)
      : await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, sk.key, data);
  return b64encode(new Uint8Array(sig));
}

/** Headers for a REST request or the WebSocket handshake. `fullPath` = e.g. "/trade-api/v2/portfolio/balance" (query string is stripped). */
export async function authHeaders(sk: SigningKey, keyId: string, method: string, fullPath: string, now = Date.now()): Promise<Record<string, string>> {
  const ts = String(now);
  const path = fullPath.split("?")[0];
  const signature = await signMessage(sk, ts + method.toUpperCase() + path);
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

// ---------- encryption at rest (AES-GCM) ----------

async function aesKey(env: { ENCRYPTION_KEY: string }): Promise<CryptoKey> {
  const raw = b64decode(env.ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be base64 of exactly 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: { ENCRYPTION_KEY: string }, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plaintext)));
  return b64encode(concat(iv, ct));
}

export async function decryptSecret(env: { ENCRYPTION_KEY: string }, blob: string): Promise<string> {
  const all = b64decode(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(env), all.slice(12));
  return dec.decode(pt);
}
