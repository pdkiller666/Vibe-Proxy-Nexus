import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ErrorState({
  message = "Не удалось загрузить данные. Проверьте соединение и попробуйте снова.",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Ошибка загрузки</AlertTitle>
      <AlertDescription className="flex items-center justify-between gap-4 flex-wrap">
        <span>{message}</span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-sm font-bold underline underline-offset-2 hover:opacity-80 shrink-0"
          >
            Повторить
          </button>
        )}
      </AlertDescription>
    </Alert>
  );
}
