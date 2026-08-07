import { useRef, useState } from "react";
import { Paperclip, X, ZoomIn, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export type AttachmentValue = { data: string; mimeType: string };

const MAX_FILE_BYTES = 5.5 * 1024 * 1024; // 5.5 MB per file
const MAX_ATTACHMENTS = 4;
// Combined raw-bytes budget so the base64 payload stays well under the 8 MB
// Express body limit (base64 adds ~33% overhead; 5 MB raw → ~6.7 MB base64).
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MB total across all files

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

/**
 * Controlled multi-file picker for support message attachments (up to 4).
 * Parent receives the full array via onChange.
 * No upload — the data is sent along with the message body.
 */
export function SupportAttachmentPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AttachmentValue[];
  onChange: (v: AttachmentValue[]) => void;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (value.length >= MAX_ATTACHMENTS) {
      toast({
        title: "Лимит вложений",
        description: `Можно прикрепить не более ${MAX_ATTACHMENTS} файлов.`,
        variant: "destructive",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      toast({
        title: "Файл слишком большой",
        description: "Максимальный размер одного вложения — 5,5 МБ.",
        variant: "destructive",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    // Check combined size before reading — base64 adds ~33% overhead,
    // so we budget the raw bytes here to stay under the server's 8 MB limit.
    const currentTotalBytes = value.reduce((sum, a) => {
      // base64 string length * 0.75 ≈ raw bytes
      return sum + Math.ceil((a.data.length * 3) / 4);
    }, 0);
    if (currentTotalBytes + file.size > MAX_TOTAL_BYTES) {
      const remainingMb = ((MAX_TOTAL_BYTES - currentTotalBytes) / 1024 / 1024).toFixed(1);
      toast({
        title: "Превышен суммарный лимит",
        description: `Все вложения вместе не должны превышать 5 МБ. Осталось ~${remainingMb} МБ.`,
        variant: "destructive",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setReading(true);
    try {
      const data = await fileToBase64(file);
      onChange([...value, { data, mimeType: file.type || "image/jpeg" }]);
    } catch {
      toast({ title: "Не удалось прочитать файл", variant: "destructive" });
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
    if (lightboxIndex === index) setLightboxIndex(null);
  }

  const canAddMore = value.length < MAX_ATTACHMENTS;

  return (
    <div className="space-y-2">
      {/* Thumbnails row */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((att, i) => {
            const previewSrc = `data:${att.mimeType};base64,${att.data}`;
            return (
              <div key={i} className="relative shrink-0 group">
                <button
                  type="button"
                  onClick={() => setLightboxIndex(i)}
                  className="block"
                  title="Нажмите для просмотра"
                >
                  <img
                    src={previewSrc}
                    alt={`Вложение ${i + 1}`}
                    className="w-16 h-16 object-cover border border-border group-hover:border-primary transition-colors"
                  />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <ZoomIn className="w-5 h-5 text-white" />
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  disabled={disabled}
                  className="absolute -top-2 -right-2 w-5 h-5 bg-destructive text-destructive-foreground flex items-center justify-center hover:opacity-80 transition-opacity"
                  title="Удалить вложение"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add button — hidden when max reached */}
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled || reading || !canAddMore}
        />
        {canAddMore && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || reading}
            className="inline-flex items-center gap-2 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            {reading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Paperclip className="w-3.5 h-3.5" />
            )}
            {reading
              ? "Читаем…"
              : value.length === 0
                ? "Прикрепить файл"
                : `Добавить ещё (${value.length}/${MAX_ATTACHMENTS})`}
          </button>
        )}
        {value.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {value.length} из {MAX_ATTACHMENTS} файлов
          </span>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && value[lightboxIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={`data:${value[lightboxIndex].mimeType};base64,${value[lightboxIndex].data}`}
              alt={`Вложение ${lightboxIndex + 1}`}
              className="max-w-full max-h-[85vh] object-contain"
            />
            <button
              type="button"
              onClick={() => setLightboxIndex(null)}
              className="absolute top-2 right-2 bg-black/60 text-white px-3 py-1 text-sm hover:bg-black/80 transition-colors"
            >
              Закрыть ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inline display of already-sent attachments in a message bubble.
 * Fetches images from the backend via indexed URLs; shows lightbox on click.
 * baseUrl: e.g. `/api/support-tickets/1/messages/2/attachments` — index appended automatically.
 */
export function SupportMessageAttachmentDisplay({
  baseUrl,
  count,
}: {
  baseUrl: string;
  count: number;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  if (count === 0) return null;

  const srcs = Array.from({ length: count }, (_, i) => `${baseUrl}/${i}`);

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {srcs.map((src, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setLightboxIndex(i)}
            className="relative group inline-block"
            title="Нажмите для просмотра"
          >
            <img
              src={src}
              alt={`Вложение ${i + 1}`}
              className="w-16 h-16 object-cover border border-border group-hover:border-primary transition-colors"
            />
            <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <ZoomIn className="w-4 h-4 text-white" />
            </div>
          </button>
        ))}
      </div>

      {lightboxIndex !== null && srcs[lightboxIndex] && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={srcs[lightboxIndex]}
              alt={`Вложение ${lightboxIndex + 1}`}
              className="max-w-full max-h-[85vh] object-contain"
            />
            {/* Navigation between images */}
            {count > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-2">
                <button
                  type="button"
                  disabled={lightboxIndex === 0}
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
                  className="bg-black/60 text-white px-3 py-1 text-sm hover:bg-black/80 transition-colors disabled:opacity-30"
                >
                  ‹
                </button>
                <span className="bg-black/60 text-white px-3 py-1 text-sm">
                  {lightboxIndex + 1} / {count}
                </span>
                <button
                  type="button"
                  disabled={lightboxIndex === count - 1}
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
                  className="bg-black/60 text-white px-3 py-1 text-sm hover:bg-black/80 transition-colors disabled:opacity-30"
                >
                  ›
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setLightboxIndex(null)}
              className="absolute top-2 right-2 bg-black/60 text-white px-3 py-1 text-sm hover:bg-black/80 transition-colors"
            >
              Закрыть ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
}
