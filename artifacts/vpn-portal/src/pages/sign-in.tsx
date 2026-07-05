import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useLogin } from "@workspace/api-client-react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignInPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const loginMutation = useLogin({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        navigate("/dashboard");
      },
    },
  });

  const errorMessage =
    loginMutation.error && "data" in loginMutation.error
      ? ((loginMutation.error.data as { error?: string } | null)?.error ??
        "Не удалось войти. Проверьте данные.")
      : loginMutation.isError
        ? "Не удалось войти. Проверьте данные."
        : null;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    loginMutation.mutate({ data: { email, password } });
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

        <h1 className="text-2xl font-bold tracking-tight text-black mb-1">
          Вход в Vibe Proxy Nexus
        </h1>
        <p className="text-gray-500 mb-6">Доступ только по приглашению</p>

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

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-black font-semibold">
                Пароль
              </Label>
              <Link
                href={`${basePath}/forgot-password`}
                className="text-xs text-orange-600 font-semibold hover:text-orange-700"
              >
                Забыли пароль?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="rounded-none border-gray-300 focus-visible:ring-orange-600"
            />
          </div>

          {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

          <Button
            type="submit"
            disabled={loginMutation.isPending}
            className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
          >
            {loginMutation.isPending ? "Вход..." : "Войти"}
          </Button>
        </form>

        <p className="text-sm text-gray-500 mt-6">
          Нет аккаунта?{" "}
          <Link href={`${basePath}/sign-up`} className="text-orange-600 font-semibold hover:text-orange-700">
            Зарегистрироваться
          </Link>
        </p>
      </div>
    </div>
  );
}
