/**
 * Symmetric encryption for secrets at rest (auth.json / API keys).
 * AES-256-GCM with the base64 `AUTH_ENCRYPTION_KEY` (32 bytes).
 *
 * Stored layout (BYTEA): [12-byte IV][16-byte auth tag][ciphertext].
 * Decrypted plaintext NEVER leaves the server (contract §7, plan P3).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadEnv } from "./env.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const b64 = loadEnv().authEncryptionKey;
  if (!b64) {
    throw new Error(
      "AUTH_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.",
    );
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) {
    throw new Error(`AUTH_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}.`);
  }
  return buf;
}

export function encryptSecret(plaintext: string | Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptSecret(blob: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
