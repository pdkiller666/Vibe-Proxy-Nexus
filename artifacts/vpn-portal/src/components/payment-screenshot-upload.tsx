import { useRef, useState } from "react";
import { useUpdatePaymentScreenshot } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, CheckCircle2, Loader2 } from "lucide-react";

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
  /** When true, label shows "обязательно" instead of "необязательно". */
  required?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
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
      queryClient.invalidateQueries({ queryKey: ["payments", "me"] });
      toast({ title: "Скриншот загружен" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Не удалось загрузить скриншот";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-bold block">
        Скриншот перевода{" "}
        <span className={required && !hasScreenshot ? "text-destructive" : "text-muted-foreground"}>
          ({required ? "обязательно" : "необязательно"})
        </span>
      </label>
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
        {uploading ? "Загружаем..." : hasScreenshot ? "Скриншот прикреплён — заменить" : "Прикрепить скриншот"}
      </button>
    </div>
  );
}
