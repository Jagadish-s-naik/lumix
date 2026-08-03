// Web Crypto API based payload encryption using AES-GCM and PBKDF2 key derivation.
// Self-contained magic header for encrypted containers: "LMXE" (Lumix Encrypted).

const CRYPTO_MAGIC = new Uint8Array([0x4c, 0x4d, 0x58, 0x45]); // LMXE
const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 100_000;

export function isEncryptedContainer(bytes: Uint8Array): boolean {
  if (bytes.length < CRYPTO_MAGIC.length + SALT_LEN + IV_LEN) return false;
  for (let i = 0; i < CRYPTO_MAGIC.length; i++) {
    if (bytes[i] !== CRYPTO_MAGIC[i]) return false;
  }
  return true;
}

async function deriveKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new Uint8Array(salt),
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPayload(payload: Uint8Array, pin: string): Promise<Uint8Array> {
  if (!pin) return payload;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(pin, salt);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(payload),
  );
  const ciphertext = new Uint8Array(cipherBuffer);

  const out = new Uint8Array(CRYPTO_MAGIC.length + SALT_LEN + IV_LEN + ciphertext.length);
  out.set(CRYPTO_MAGIC, 0);
  out.set(salt, CRYPTO_MAGIC.length);
  out.set(iv, CRYPTO_MAGIC.length + SALT_LEN);
  out.set(ciphertext, CRYPTO_MAGIC.length + SALT_LEN + IV_LEN);
  return out;
}

export async function decryptPayload(encryptedContainer: Uint8Array, pin: string): Promise<Uint8Array> {
  if (!isEncryptedContainer(encryptedContainer)) {
    return encryptedContainer;
  }
  const salt = encryptedContainer.slice(CRYPTO_MAGIC.length, CRYPTO_MAGIC.length + SALT_LEN);
  const iv = encryptedContainer.slice(
    CRYPTO_MAGIC.length + SALT_LEN,
    CRYPTO_MAGIC.length + SALT_LEN + IV_LEN,
  );
  const ciphertext = encryptedContainer.slice(CRYPTO_MAGIC.length + SALT_LEN + IV_LEN);
  const key = await deriveKey(pin, salt);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      key,
      new Uint8Array(ciphertext),
    );
    return new Uint8Array(decryptedBuffer);
  } catch {
    throw new Error("Decryption failed. Invalid PIN or corrupted secret key.");
  }
}
