import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { useLayoutEffect, useState } from "react";
import PageTransition from "@/components/PageTransition";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import SmsCompliance from "./pages/SmsCompliance";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import TermsConditions from "./pages/TermsConditions";
import Reviews from "./pages/Reviews";
import Valentines from "./pages/Valentines";
import Order from "./pages/Order";
import OrderCheckout from "./pages/OrderCheckout";
import OrderConfirmation from "./pages/OrderConfirmation";
import DowntownU from "./pages/DowntownU";
import DowntownUPortal from "./features/downtown-u/DowntownUPortal";
import OperatorAuth from "./features/downtown-u/operator-auth/OperatorAuth";
import OperatorDashboard from "./features/downtown-u/operator-dashboard/OperatorDashboard";
import { consumeOperatorAuthFragment, type FragmentResult } from "./features/downtown-u/operator-auth/fragment";

const queryClient = new QueryClient();

const App = () => {
  // The email provider delivers the BrowserRouter auth pathname with one-time
  // credentials in its fragment so they never reach the server. Consume and
  // erase an initial fragment before BrowserRouter or page UI mounts.
  const [operatorFragment, setOperatorFragment] = useState<{ result: FragmentResult; generation: number }>(() => ({
    result: consumeOperatorAuthFragment(),
    generation: 0,
  }));

  // App stays mounted for same-path fragment navigation. Consume future auth
  // fragments synchronously in the native event handler, then use a non-secret
  // generation to reset the auth flow and supersede any pending session probe.
  useLayoutEffect(() => {
    const handleHashChange = () => {
      const result = consumeOperatorAuthFragment();
      if (result.kind === "none") return;
      setOperatorFragment((current) => ({ result, generation: current.generation + 1 }));
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const initialOperatorCredentials = operatorFragment.result.kind === "valid" ? operatorFragment.result.credentials : null;
  const invalidOperatorFragment = operatorFragment.result.kind === "invalid";

  return <QueryClientProvider client={queryClient}>
    <Toaster />
    <Sonner />
    <BrowserRouter>
      <PageTransition>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/valentines" element={<Valentines />} />
          <Route path="/order" element={<Order />} />
          <Route path="/order/checkout" element={<OrderCheckout />} />
          <Route path="/order/confirmation" element={<OrderConfirmation />} />
          <Route path="/downtown-u" element={<DowntownU />} />
          <Route path="/downtown-u/portal" element={<DowntownUPortal />} />
          <Route path="/downtown-u/operator/auth" element={<OperatorAuth key={operatorFragment.generation} initialCredentials={initialOperatorCredentials} invalidFragment={invalidOperatorFragment} />} />
          <Route path="/downtown-u/operator/*" element={<OperatorDashboard />} />
          <Route path="/sms-compliance" element={<SmsCompliance />} />
          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms-conditions" element={<TermsConditions />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </PageTransition>
    </BrowserRouter>
  </QueryClientProvider>;
};

export default App;
