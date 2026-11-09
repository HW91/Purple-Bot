import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify, verify, constants } from "node:crypto";
import { importSigningKey, signMessage, authHeaders, encryptSecret, decryptSecret, b64decode } from "../src/kalshi-auth";

describe("Kalshi request signing", () => {
  it("signs with RSA-PSS/SHA-256/salt 32 from a PKCS#1 ('BEGIN RSA PRIVATE KEY') file", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(privateKey).toContain("BEGIN RSA PRIVATE KEY");
    const sk = await importSigningKey(privateKey);
    expect(sk.kind).toBe("rsa");
    const msg = "1703123456789GET/trade-api/v2/portfolio/balance";
    const sig = b64decode(await signMessage(sk, msg));
    const ok = createVerify("sha256").update(msg).verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    expect(ok).toBe(true);
  });

  it("signs with RSA-PSS from a PKCS#8 ('BEGIN PRIVATE KEY') file", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const sk = await importSigningKey(privateKey);
    expect(sk.kind).toBe("rsa");
    const sig = b64decode(await signMessage(sk, "abc"));
    expect(createVerify("sha256").update("abc").verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig)).toBe(true);
  });

  it("signs Ed25519 keys directly", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const sk = await importSigningKey(privateKey);
    expect(sk.kind).toBe("ed25519");
    const sig = b64decode(await signMessage(sk, "hello"));
    expect(verify(null, Buffer.from("hello"), publicKey, sig)).toBe(true);
  });

  it("strips the query string before signing and builds all three headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const sk = await importSigningKey(privateKey);
    const h = await authHeaders(sk, "key-id", "get", "/trade-api/v2/markets?limit=5", 1700000000000);
    expect(h["KALSHI-ACCESS-KEY"]).toBe("key-id");
    expect(h["KALSHI-ACCESS-TIMESTAMP"]).toBe("1700000000000");
    expect(verify(null, Buffer.from("1700000000000GET/trade-api/v2/markets"), publicKey, b64decode(h["KALSHI-ACCESS-SIGNATURE"]))).toBe(true);
  });

  it("rejects junk and password-protected keys with plain messages", async () => {
    await expect(importSigningKey("not a key")).rejects.toThrow(/PEM/);
    await expect(importSigningKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----")).rejects.toThrow(/Password/);
  });
});

describe("encryption at rest", () => {
  it("round-trips and never stores plaintext", async () => {
    const env = { ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) };
    const blob = await encryptSecret(env, "-----BEGIN PRIVATE KEY-----secret");
    expect(blob).not.toContain("secret");
    expect(await decryptSecret(env, blob)).toBe("-----BEGIN PRIVATE KEY-----secret");
    const other = { ENCRYPTION_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) };
    await expect(decryptSecret(other, blob)).rejects.toBeTruthy();
  });
});
