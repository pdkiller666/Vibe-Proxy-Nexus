/**
 * Shared image validation used by payments (screenshot) and support (attachment).
 * Three independent checks: MIME allowlist → size cap → magic bytes.
 */

export const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_BASE64_BYTES = 8 * 1024 * 1024; // 8 MB base64 ≈ 6 MB decoded

const MAGIC: Record<string, (buf: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  "image/webp": (b) =>
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50, // WEBP
};

/**
 * Validates a base64-encoded image.
 * Returns an error string or null if valid.
 */
export function validateImage(mimeType: string, data: string): string | null {
  if (!ALLOWED_MIME_TYPES.has(mimeType))
    return `Недопустимый тип файла. Разрешены: ${[...ALLOWED_MIME_TYPES].join(", ")}`;
  if (data.length > MAX_BASE64_BYTES) return "Файл слишком большой (максимум 6 МБ)";
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return "Некорректный base64";
  }
  const check = MAGIC[mimeType];
  if (check && !check(buf)) return "Содержимое файла не соответствует указанному типу";
  return null;
}
