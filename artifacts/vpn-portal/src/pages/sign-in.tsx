import { useLocation } from "wouter";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLogin } from "@workspace/api-client-react";
import { LoginBody } from "@workspace/api-zod";
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

type LoginFormValues = {
  email: string;
  password: string;
};

export default function SignInPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(LoginBody),
    defaultValues: { email: "", password: "" },
  });

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

  function onSubmit(values: LoginFormValues) {
    loginMutation.mutate({ data: values });
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
      <div className="w-[440px] max-w-full bg-white border border-black/10 p-8">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 bg-orange-600 flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg tracking-tight">VPNexus</span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-black mb-1">
          Вход в VPNexus
        </h1>
        <p className="text-gray-500 mb-6">Доступ только по приглашению</p>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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
                  <div className="flex items-center justify-between">
                    <FormLabel className="text-black font-semibold">Пароль</FormLabel>
                    <Link
                      href={`${basePath}/forgot-password`}
                      className="text-xs text-orange-600 font-semibold hover:text-orange-700"
                    >
                      Забыли пароль?
                    </Link>
                  </div>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      className="rounded-none border-gray-300 focus-visible:ring-orange-600"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}

            <Button
              type="submit"
              disabled={loginMutation.isPending}
              className="w-full rounded-none bg-orange-600 hover:bg-orange-700 text-white font-mono"
            >
              {loginMutation.isPending ? "Вход..." : "Войти"}
            </Button>
          </form>
        </Form>

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
