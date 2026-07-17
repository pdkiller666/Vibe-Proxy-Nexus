import { useRef, useState } from "react";
import {
  useUpdatePaymentScreenshot,
  getListMyPaymentsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, CheckCircle2, Loader2, ZoomIn } from "lucide-react";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

export function PaymentScreenshotUpload({
  paymentId,
  hasScreenshot,
  required = false,
}: {
  paymentId: number;
  hasScreenshot?: boolean | null;
  /** When true, label says "обязательно" and highlights until screenshot uploaded. */
  required?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { mutateAsync: updateScreenshot } = useUpdatePaymentScreenshot();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_FILE_BYTES = 5.5 * 1024 * 1024;
    if (file.size > MAX_FILE_BYTES) {
      toast({
        title: "Файл слишком большой",
        description: "Максимальный размер скриншота — 5,5 МБ. Сожмите изображение и попробуйте снова.",
        variant: "destructive",
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    setUploading(true);
    try {
      const data = await fileToBase64(file);
      await updateScreenshot({
        paymentId,
        data: { data, mimeType: file.type || "application/octet-stream" },
      });
      // Invalidate the correct query key used by all checkout pages
      queryClient.invalidateQueries({ queryKey: getListMyPaymentsQueryKey() });
      toast({ title: "Скриншот загружен" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Не удалось загрузить скриншот";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const screenshotUrl = `/api/payments/${paymentId}/screenshot/image`;

  return (
    <div className="space-y-2">
      <label className="text-sm font-bold block">
        Скриншот перевода{" "}
        <span className={required && !hasScreenshot ? "text-destructive" : "text-muted-foreground"}>
          ({required ? "обязательно" : "необязательно"})
        </span>
      </label>

      {/* Thumbnail + actions row */}
      <div className="flex items-start gap-3 flex-wrap">
        {hasScreenshot && (
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="relative shrink-0 group"
            title="Нажмите чтобы просмотреть"
          >
            <img
              src={screenshotUrl}
              alt="Скриншот перевода"
              className="w-20 h-20 object-cover border border-border group-hover:border-primary transition-colors"
            />
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <ZoomIn className="w-6 h-6 text-white" />
            </div>
          </button>
        )}

        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
            disabled={uploading}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : hasScreenshot ? (
              <CheckCircle2 className="w-4 h-4 text-green-600" />
            ) : (
              <ImageUp className="w-4 h-4" />
            )}
            {uploading
              ? "Загружаем..."
              : hasScreenshot
              ? "Заменить скриншот"
              : "Прикрепить скриншот"}
          </button>
          {hasScreenshot && (
            <a
              href={screenshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Открыть в полном размере
            </a>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightboxOpen && hasScreenshot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxOpen(false)}
        >
          <div className="relative max-w-3xl max-h-[90vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <img
              src={screenshotUrl}
              alt="Скриншот перевода"
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
