import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRegister } from "@workspace/api-client-react";
import { RegisterBody } from "@workspace/api-zod";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type RegisterFormValues = {
  email: string;
  password: string;
  name?: string;
};

export default function SignUpPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(RegisterBody),
    defaultValues: { email: "", password: "", name: "" },
  });

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

  function onSubmit(values: RegisterFormValues) {
    registerMutation.mutate({ data: { ...values, name: values.name || undefined } });
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

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-black font-semibold">Имя (необязательно)</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      autoComplete="name"
                      className="rounded-none border-gray-300 focus-visible:ring-orange-600"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-black font-semibold">Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      className="rounded-none border-gray-300 focus-visible:ring-orange-600"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-black font-semibold">Пароль</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      className="rounded-none border-gray-300 focus-visible:ring-orange-600"
                      {...field}
                    />
                  </FormControl>
                  <p className="text-xs text-gray-400">Минимум 8 символов</p>
                  <FormMessage />
                </FormItem>
              )}
            />

            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

            <Button
              type="submit"
              disabled={registerMutation.isPending}
              className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
            >
              {registerMutation.isPending ? "Регистрация..." : "Зарегистрироваться"}
            </Button>
          </form>
        </Form>

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
