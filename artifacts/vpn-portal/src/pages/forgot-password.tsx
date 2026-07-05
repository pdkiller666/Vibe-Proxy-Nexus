import { useState } from "react";
import { Link } from "wouter";
import { useForgotPassword } from "@workspace/api-client-react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");

  const forgotPasswordMutation = useForgotPassword();

  const errorMessage =
    forgotPasswordMutation.error && "data" in forgotPasswordMutation.error
      ? ((forgotPasswordMutation.error.data as { error?: string } | null)?.error ??
        "Не удалось отправить запрос. Попробуйте позже.")
      : forgotPasswordMutation.isError
        ? "Не удалось отправить запрос. Попробуйте позже."
        : null;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    forgotPasswordMutation.mutate({ data: { email } });
  }

  const result = forgotPasswordMutation.data;

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
      <div className="w-[440px] max-w-full bg-white border border-black/10 p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">NEXUS</span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-black mb-1">Восстановление пароля</h1>
        <p className="text-gray-500 mb-6">Введите email, указанный при регистрации</p>

        {!result ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-black font-semibold">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-none border-gray-300 focus-visible:ring-orange-600"
              />
            </div>

            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

            <Button
              type="submit"
              disabled={forgotPasswordMutation.isPending}
              className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
            >
              {forgotPasswordMutation.isPending ? "Отправка..." : "Отправить ссылку для сброса"}
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-gray-700">{result.message}</p>

            <div className="space-y-1.5 border border-black/10 bg-gray-50 p-4">
              <p className="text-xs text-gray-500">
                Автоматическая отправка писем ещё не настроена. Если у вас есть аккаунт, обратитесь в поддержку —
                администратор сгенерирует для вас ссылку для сброса пароля.
              </p>
            </div>
          </div>
        )}

        <p className="text-sm text-gray-500 mt-6">
          Вспомнили пароль?{" "}
          <Link href={`${basePath}/sign-in`} className="text-orange-600 font-semibold hover:text-orange-700">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
