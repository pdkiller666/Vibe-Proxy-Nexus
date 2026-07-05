import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useResetPassword } from "@workspace/api-client-react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const token = new URLSearchParams(search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const resetPasswordMutation = useResetPassword();

  const errorMessage = mismatch
    ? "Пароли не совпадают"
    : resetPasswordMutation.error && "data" in resetPasswordMutation.error
      ? ((resetPasswordMutation.error.data as { error?: string } | null)?.error ??
        "Не удалось сбросить пароль. Попробуйте запросить новую ссылку.")
      : resetPasswordMutation.isError
        ? "Не удалось сбросить пароль. Попробуйте запросить новую ссылку."
        : null;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (password !== confirmPassword) {
      setMismatch(true);
      return;
    }

    setMismatch(false);
    resetPasswordMutation.mutate(
      { data: { token, password } },
      {
        onSuccess: () => {
          navigate("/sign-in");
        },
      },
    );
  }

  if (!token) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
        <div className="w-[440px] max-w-full bg-white border border-black/10 p-8">
          <h1 className="text-2xl font-bold tracking-tight text-black mb-1">Ссылка недействительна</h1>
          <p className="text-gray-500 mb-6">
            В ссылке отсутствует токен сброса пароля. Запросите новую ссылку.
          </p>
          <Link
            href={`${basePath}/forgot-password`}
            className="text-orange-600 font-semibold hover:text-orange-700"
          >
            Запросить сброс пароля
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
      <div className="w-[440px] max-w-full bg-white border border-black/10 p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">NEXUS</span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-black mb-1">Новый пароль</h1>
        <p className="text-gray-500 mb-6">Введите новый пароль для вашего аккаунта</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-black font-semibold">
              Новый пароль
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-none border-gray-300 focus-visible:ring-orange-600"
            />
            <p className="text-xs text-gray-400">Минимум 8 символов</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirmPassword" className="text-black font-semibold">
              Повторите пароль
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="rounded-none border-gray-300 focus-visible:ring-orange-600"
            />
          </div>

          {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

          <Button
            type="submit"
            disabled={resetPasswordMutation.isPending}
            className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
          >
            {resetPasswordMutation.isPending ? "Сохранение..." : "Сохранить новый пароль"}
          </Button>
        </form>

        <p className="text-sm text-gray-500 mt-6">
          <Link href={`${basePath}/sign-in`} className="text-orange-600 font-semibold hover:text-orange-700">
            Вернуться ко входу
          </Link>
        </p>
      </div>
    </div>
  );
}
