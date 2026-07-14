import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { useGetMe } from "@workspace/api-client-react";

import Home from "@/pages/home";
import Dashboard from "@/pages/dashboard";
import Plans from "@/pages/plans";
import Checkout from "@/pages/checkout";
import SlotCheckout from "@/pages/slot-checkout";
import TrafficCheckout from "@/pages/traffic-checkout";
import BalanceTopup from "@/pages/balance-topup";
import Payments from "@/pages/payments";
import Keys from "@/pages/keys";
import Support from "@/pages/support";
import Profile from "@/pages/profile";
import Admin from "@/pages/admin";
import SignInPage from "@/pages/sign-in";
import SignUpPage from "@/pages/sign-up";
import ForgotPasswordPage from "@/pages/forgot-password";
import ResetPasswordPage from "@/pages/reset-password";
import TermsPage from "@/pages/terms";
import PrivacyPage from "@/pages/privacy";
import { Layout } from "@/components/layout";
import { queryClient } from "@/lib/query-client";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function HomeRedirect() {
  const { data: me, isLoading, isError } = useGetMe();

  if (isLoading) {
    return <div className="min-h-screen bg-gray-50" />;
  }

  if (me && !isError) {
    return <Redirect to="/dashboard" />;
  }

  return <Home />;
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading, isError } = useGetMe();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#F4F4F5]">
        <div className="text-muted-foreground">Загрузка...</div>
      </div>
    );
  }

  if (!me || isError) {
    return <Redirect to="/sign-in" />;
  }

  return (
    <Layout>
      <Component />
    </Layout>
  );
}

function AdminRoute() {
  const { data: me, isLoading, isError } = useGetMe();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#F4F4F5]">
        <div className="text-muted-foreground">Загрузка...</div>
      </div>
    );
  }

  if (!me || isError) {
    return <Redirect to="/sign-in" />;
  }

  if (me.role !== "admin") {
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
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in" component={SignInPage} />
          <Route path="/sign-up" component={SignUpPage} />
          <Route path="/forgot-password" component={ForgotPasswordPage} />
          <Route path="/reset-password" component={ResetPasswordPage} />

          <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
          <Route path="/plans"><ProtectedRoute component={Plans} /></Route>
          <Route path="/checkout/:id"><ProtectedRoute component={Checkout} /></Route>
          <Route path="/checkout/slot/:id"><ProtectedRoute component={SlotCheckout} /></Route>
          <Route path="/checkout/traffic/:id"><ProtectedRoute component={TrafficCheckout} /></Route>
          <Route path="/balance-topup/:id"><ProtectedRoute component={BalanceTopup} /></Route>
          <Route path="/payments"><ProtectedRoute component={Payments} /></Route>
          <Route path="/keys"><ProtectedRoute component={Keys} /></Route>
          <Route path="/support"><ProtectedRoute component={Support} /></Route>
          <Route path="/profile"><ProtectedRoute component={Profile} /></Route>
          <Route path="/admin" component={AdminRoute} />
          <Route path="/terms" component={TermsPage} />
          <Route path="/privacy" component={PrivacyPage} />

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
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
