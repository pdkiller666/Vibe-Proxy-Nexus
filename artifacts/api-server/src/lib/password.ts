import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
// N=16384 is Node's default and safe for the current container memory budget.
// Bumping N requires: (1) enough container memory for 128*N*r bytes per login,
// (2) re-hashing all existing passwords — can't just change N and expect old
// hashes to verify. Both conditions must be met before raising this value.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

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
