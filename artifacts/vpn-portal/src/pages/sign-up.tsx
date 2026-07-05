import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useRegister } from "@workspace/api-client-react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignUpPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  const registerMutation = useRegister({
    mutation: {
      onSuccess: () => {
        queryClient.clear();
        navigate("/dashboard");
      },
    },
  });

  const errorMessage =
    registerMutation.error && "data" in registerMutation.error
      ? ((registerMutation.error.data as { error?: string } | null)?.error ??
        "Не удалось зарегистрироваться.")
      : registerMutation.isError
        ? "Не удалось зарегистрироваться."
        : null;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    registerMutation.mutate({ data: { email, password, name: name || undefined } });
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
          Регистрация в Vibe Proxy Nexus
        </h1>
        <p className="text-gray-500 mb-6">Создайте аккаунт для доступа к сервису</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name" className="text-black font-semibold">
              Имя (необязательно)
            </Label>
            <Input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="rounded-none border-gray-300 focus-visible:ring-orange-600"
            />
          </div>

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
            <Label htmlFor="password" className="text-black font-semibold">
              Пароль
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

          {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

          <Button
            type="submit"
            disabled={registerMutation.isPending}
            className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
          >
            {registerMutation.isPending ? "Регистрация..." : "Зарегистрироваться"}
          </Button>
        </form>

        <p className="text-sm text-gray-500 mt-6">
          Уже есть аккаунт?{" "}
          <Link href={`${basePath}/sign-in`} className="text-orange-600 font-semibold hover:text-orange-700">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
