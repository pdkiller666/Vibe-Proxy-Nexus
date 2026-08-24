import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ReferralQrDialogProps = {
  value: string;
  title: string;
  description: string;
  buttonLabel?: string;
  className?: string;
};

export function ReferralQrDialog({
  value,
  title,
  description,
  buttonLabel = "Показать QR",
  className,
}: ReferralQrDialogProps) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) {
      setDataUrl(null);
      setError(false);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(value, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center gap-1.5 border border-border px-3 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors ${className ?? ""}`}
          aria-label={title}
        >
          <QrCode className="w-4 h-4" />
          {buttonLabel}
        </button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-none sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center">
          {dataUrl ? (
            <img src={dataUrl} alt={title} className="h-64 w-64" />
          ) : error ? (
            <p className="py-20 text-center text-sm text-destructive">Не удалось создать QR-код.</p>
          ) : (
            <div className="h-64 w-64 animate-pulse bg-muted" aria-label="QR-код загружается" />
          )}
        </div>
        <p className="break-all border border-border bg-muted/40 px-3 py-2 text-center font-mono text-xs text-muted-foreground">
          {value}
        </p>
      </DialogContent>
    </Dialog>
  );
}