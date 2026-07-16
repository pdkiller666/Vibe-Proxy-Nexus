import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
// N=65536 (4× the Node default of 16384) increases GPU crack resistance without
// noticeably impacting login latency on modern hardware (~250ms). Tests override
// this to N=1024 via SCRYPT_N_OVERRIDE to avoid hitting sandbox memory limits.
// Must stay in sync between hashPassword and verifyPassword.
const SCRYPT_N = process.env.SCRYPT_N_OVERRIDE
  ? parseInt(process.env.SCRYPT_N_OVERRIDE, 10)
  : 65536;
const SCRYPT_PARAMS = { N: SCRYPT_N, r: 8, p: 1 };

// Promisified manually to preserve the options parameter (the util.promisify
// overload for scrypt doesn't expose the 4-argument form in its TypeScript types).
function scrypt(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, keylen, SCRYPT_PARAMS, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  return `${salt}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;

  const derivedKey = await scrypt(password, salt, KEY_LENGTH);
  const storedKey = Buffer.from(hash, "hex");

  if (derivedKey.length !== storedKey.length) return false;
  return timingSafeEqual(derivedKey, storedKey);
}
