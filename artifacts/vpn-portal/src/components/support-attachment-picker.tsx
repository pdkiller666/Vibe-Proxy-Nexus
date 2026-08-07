import { useRef, useState } from "react";
import { Paperclip, X, ZoomIn, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export type AttachmentValue = { data: string; mimeType: string };

const MAX_FILE_BYTES = 5.5 * 1024 * 1024; // 5.5 MB — matches payment screenshot limit

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
 * Controlled file picker for support message attachments.
 * Holds the base64 payload locally; parent receives it via onChange.
 * No upload — the data is sent along with the message body.
 */
export function SupportAttachmentPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AttachmentValue | null;
  onChange: (v: AttachmentValue | null) => void;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      toast({
        title: "Файл слишком большой",
        description: "Максимальный размер вложения — 5,5 МБ.",
        variant: "destructive",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setReading(true);
    try {
      const data = await fileToBase64(file);
      onChange({ data, mimeType: file.type || "image/jpeg" });
    } catch {
      toast({ title: "Не удалось прочитать файл", variant: "destructive" });
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function clear() {
    onChange(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const previewSrc = value
    ? `data:${value.mimeType};base64,${value.data}`
    : null;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || reading}
      />

      {/* Thumbnail when file is selected */}
      {previewSrc && (
        <div className="relative shrink-0 group">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block"
            title="Нажмите для просмотра"
          >
            <img
              src={previewSrc}
              alt="Вложение"
              className="w-16 h-16 object-cover border border-border group-hover:border-primary transition-colors"
            />
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <ZoomIn className="w-5 h-5 text-white" />
            </div>
          </button>
          {/* Clear button */}
          <button
            type="button"
            onClick={clear}
            disabled={disabled}
            className="absolute -top-2 -right-2 w-5 h-5 bg-destructive text-destructive-foreground flex items-center justify-center hover:opacity-80 transition-opacity"
            title="Удалить вложение"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Pick / replace button */}
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
        {reading ? "Читаем…" : value ? "Заменить файл" : "Прикрепить файл"}
      </button>

      {/* Lightbox */}
      {lightboxOpen && previewSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewSrc}
              alt="Вложение"
              className="max-w-full max-h-[85vh] object-contain"
            />
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
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
 * Inline display of an already-sent attachment in a message bubble.
 * Fetches from the backend via the URL; shows lightbox on click.
 */
export function SupportMessageAttachmentDisplay({ src }: { src: string }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setLightboxOpen(true)}
        className="relative mt-2 group inline-block"
        title="Нажмите для просмотра"
      >
        <img
          src={src}
          alt="Вложение"
          className="max-w-[200px] max-h-[140px] object-cover border border-border group-hover:border-primary transition-colors"
        />
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <ZoomIn className="w-5 h-5 text-white" />
        </div>
      </button>

      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="relative max-w-3xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt="Вложение"
              className="max-w-full max-h-[85vh] object-contain"
            />
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
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
