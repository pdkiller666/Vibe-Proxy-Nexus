import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { useGetMe } from "@workspace/api-client-react";
import { lazy, Suspense } from "react";

const Home = lazy(() => import("@/pages/home"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Plans = lazy(() => import("@/pages/plans"));
const Checkout = lazy(() => import("@/pages/checkout"));
const SlotCheckout = lazy(() => import("@/pages/slot-checkout"));
const TrafficCheckout = lazy(() => import("@/pages/traffic-checkout"));
const BalanceTopup = lazy(() => import("@/pages/balance-topup"));
const Payments = lazy(() => import("@/pages/payments"));
const Keys = lazy(() => import("@/pages/keys"));
const Support = lazy(() => import("@/pages/support"));
const Profile = lazy(() => import("@/pages/profile"));
const Admin = lazy(() => import("@/pages/admin"));
const SignInPage = lazy(() => import("@/pages/sign-in"));
const SignUpPage = lazy(() => import("@/pages/sign-up"));
const ForgotPasswordPage = lazy(() => import("@/pages/forgot-password"));
const ResetPasswordPage = lazy(() => import("@/pages/reset-password"));
const TermsPage = lazy(() => import("@/pages/terms"));
const PrivacyPage = lazy(() => import("@/pages/privacy"));
import { Layout } from "@/components/layout";
import { queryClient } from "@/lib/query-client";
import { Seo, homeSeo } from "@/components/seo";

function PageFallback() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center bg-[#F4F4F5]">
      <div className="text-muted-foreground">Загрузка...</div>
    </div>
  );
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function HomeRedirect() {
  const { data: me, isLoading, isError } = useGetMe();

  if (isLoading) {
    return <div className="min-h-screen bg-gray-50" />;
  }

  if (me && !isError) {
    return <Redirect to="/dashboard" />;
  }

  return <><Seo {...homeSeo} /><Home /></>;
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

  if (me.isBanned) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 bg-[#F4F4F5] p-8 text-center">
        <div className="text-2xl font-semibold text-red-600">Аккаунт заблокирован</div>
        <p className="text-sm text-gray-500 max-w-sm">
          Ваш аккаунт был заблокирован администратором. Если вы считаете это ошибкой, обратитесь в поддержку.
        </p>
      </div>
    );
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

  if (me.isBanned) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-4 bg-[#F4F4F5] p-8 text-center">
        <div className="text-2xl font-semibold text-red-600">Аккаунт заблокирован</div>
        <p className="text-sm text-gray-500 max-w-sm">
          Ваш аккаунт был заблокирован администратором. Если вы считаете это ошибкой, обратитесь в поддержку.
        </p>
      </div>
    );
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
        <Suspense fallback={<PageFallback />}>
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
        </Suspense>
      </WouterRouter>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
