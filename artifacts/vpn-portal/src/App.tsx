import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { useEffect, useRef } from "react";
import { Toaster } from "@/components/ui/toaster";
import { useGetMe } from "@workspace/api-client-react";

import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Plans from "@/pages/plans";
import Checkout from "@/pages/checkout";
import Payments from "@/pages/payments";
import Keys from "@/pages/keys";
import Admin from "@/pages/admin";
import { Layout } from "@/components/layout";
import { queryClient } from "@/lib/query-client";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  cssLayerName: "clerk",
  variables: {
    colorPrimary: "hsl(24 98% 44%)",
    colorForeground: "hsl(240 10% 3.9%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInputText: "hsl(240 10% 3.9%)",
    colorNeutral: "hsl(240 5.9% 90%)",
    borderRadius: "0px",
  },
  elements: {
    cardBox: "bg-white rounded-none border border-black/10 shadow-none w-[440px] max-w-full",
    card: "!bg-transparent",
    footer: "!bg-transparent",
    headerTitle: "text-2xl font-bold tracking-tight text-black",
    headerSubtitle: "text-gray-500",
    formButtonPrimary: "bg-orange-600 hover:bg-orange-700 text-white border-0 shadow-none rounded-none font-mono",
    formFieldInput: "rounded-none border-gray-300 focus:border-orange-600 focus:ring-1 focus:ring-orange-600",
    formFieldLabel: "text-black font-semibold",
    footerActionLink: "text-orange-600 hover:text-orange-700 font-semibold",
    footerActionText: "text-gray-500",
  }
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

const clerkLocalization = {
  locale: "ru-RU",
  signIn: {
    start: {
      title: "Вход в Vibe Proxy Nexus",
      subtitle: "Доступ только по приглашению",
    },
  },
  signUp: {
    start: {
      title: "Регистрация в Vibe Proxy Nexus",
      subtitle: "Создайте аккаунт для доступа к сервису",
    },
  },
} as const;

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#F4F4F5] px-4 font-sans">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <>
      <Show when="signed-in">
        <Layout>
          <Component />
        </Layout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function AdminRoute() {
  const { data: me, isLoading } = useGetMe();

  if (isLoading) {
    return (
      <Layout>
        <div className="text-muted-foreground">Загрузка...</div>
      </Layout>
    );
  }

  if (me?.role !== "admin") {
    return <Redirect to="/dashboard" />;
  }

  return (
    <Layout>
      <Admin />
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={basePath}>
        <ClerkProvider
          publishableKey={clerkPubKey}
          proxyUrl={clerkProxyUrl}
          appearance={clerkAppearance}
          localization={clerkLocalization}
          signInUrl={`${basePath}/sign-in`}
          signUpUrl={`${basePath}/sign-up`}
        >
          <ClerkQueryClientCacheInvalidator />
          <Switch>
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            
            <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
            <Route path="/plans"><ProtectedRoute component={Plans} /></Route>
            <Route path="/checkout/:id"><ProtectedRoute component={Checkout} /></Route>
            <Route path="/payments"><ProtectedRoute component={Payments} /></Route>
            <Route path="/keys"><ProtectedRoute component={Keys} /></Route>
            <Route path="/admin">
              <Show when="signed-in">
                <AdminRoute />
              </Show>
              <Show when="signed-out">
                <Redirect to="/sign-in" />
              </Show>
            </Route>
            
            <Route path="/:rest*">
              {() => (
                <div className="min-h-screen bg-gray-50 flex items-center justify-center">
                  <div className="bg-white border p-8 text-center">
                    <h1 className="text-xl font-bold mb-2">404</h1>
                    <p className="text-gray-500">Страница не найдена</p>
                    <a href="/" className="text-orange-600 block mt-4 font-medium">На главную</a>
                  </div>
                </div>
              )}
            </Route>
          </Switch>
        </ClerkProvider>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
