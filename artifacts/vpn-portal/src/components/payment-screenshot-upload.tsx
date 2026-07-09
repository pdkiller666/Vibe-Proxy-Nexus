import { useRef, useState } from "react";
import { useRequestUploadUrl, useUpdatePaymentScreenshot } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ImageUp, CheckCircle2, Loader2 } from "lucide-react";

export function PaymentScreenshotUpload({
  paymentId,
  screenshotUrl,
}: {
  paymentId: number;
  screenshotUrl?: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { mutateAsync: requestUploadUrl } = useRequestUploadUrl();
  const { mutateAsync: updateScreenshot } = useUpdatePaymentScreenshot();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl({
        data: {
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        },
      });

      const putRes = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error("Не удалось загрузить файл");

      await updateScreenshot({ paymentId, data: { screenshotUrl: objectPath } });
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
      <label className="text-sm font-bold block">Скриншот перевода (необязательно)</label>
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
        ) : screenshotUrl ? (
          <CheckCircle2 className="w-4 h-4 text-green-600" />
        ) : (
          <ImageUp className="w-4 h-4" />
        )}
        {uploading ? "Загружаем..." : screenshotUrl ? "Скриншот прикреплён — заменить" : "Прикрепить скриншот"}
      </button>
    </div>
  );
}
