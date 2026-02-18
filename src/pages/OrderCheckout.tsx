import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCart, DELIVERY_FEE, ESTIMATED_DELIVERY_TIME } from "@/hooks/useCart";
import { useOrderType } from "@/hooks/useOrderType";
import { formatPrice } from "@/data/menu";
import {
  ArrowLeft,
  Clock,
  CreditCard,
  User,
  Phone,
  Mail,
  ShoppingBag,
  Shield,
  Heart,
  Check,
  Apple,
  Banknote,
  Minus,
  Plus,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SQUARE_APP_ID = "sq0idp-ckcAIc_AeKVuekaXP7rBSA";
const SQUARE_LOCATION_ID = "LPPWSSV03BHK8";

const TIP_OPTIONS = [
  { label: "15%", value: 0.15 },
  { label: "20%", value: 0.20 },
  { label: "25%", value: 0.25 },
];

// Store hours: Mon-Fri 3PM-11PM, Sat-Sun 12PM-11PM
const STORE_HOURS: Record<number, [number, number]> = {
  0: [12, 23], // Sunday
  1: [15, 23], // Monday
  2: [15, 23], // Tuesday
  3: [15, 23], // Wednesday
  4: [15, 23], // Thursday
  5: [15, 23], // Friday
  6: [12, 23], // Saturday
};

function generatePickupTimes(): { label: string; value: string }[] {
  const now = new Date();
  const day = now.getDay();
  const [openHour, closeHour] = STORE_HOURS[day];
  const times: { label: string; value: string }[] = [];
  const startMin = 25; // minimum prep time

  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + (startMin + i * 15) * 60000);
    const dHour = d.getHours() + d.getMinutes() / 60;
    // Only show times within store hours
    if (dHour < openHour || dHour >= closeHour) continue;
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const h = hours % 12 || 12;
    const m = minutes.toString().padStart(2, "0");
    const label = `${h}:${m} ${ampm}`;
    times.push({ label, value: d.toISOString() });
  }
  return times;
}

type PaymentMethod = "card" | "apple-pay" | "cashapp";

const OrderCheckout = () => {
  const cart = useCart();
  const { orderType } = useOrderType();
  const navigate = useNavigate();
  const { toast } = useToast();

  // Restore form data from sessionStorage (Cash App Pay redirect return)
  const savedForm = useMemo(() => {
    try {
      const raw = sessionStorage.getItem("proper_cashapp_form");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }, []);

  const [name, setName] = useState(savedForm?.name || "");
  const [phone, setPhone] = useState(savedForm?.phone || "");
  const [email, setEmail] = useState(savedForm?.email || "");
  const [pickupTime, setPickupTime] = useState(savedForm?.pickupTime || "asap");
  const [tipPercent, setTipPercent] = useState<number | null>(savedForm?.tipPercent ?? 0.20);
  const [customTip, setCustomTip] = useState(savedForm?.customTip || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [cashAppPayAvailable, setCashAppPayAvailable] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState<PaymentMethod>("card");

  const cardRef = useRef<any>(null);
  const paymentsRef = useRef<any>(null);
  const applePayRef = useRef<any>(null);
  const cashAppPayRef = useRef<any>(null);
  const processOrderRef = useRef<(nonce: string | null) => Promise<void>>();

  const pickupTimes = useMemo(() => generatePickupTimes(), []);

  const tipAmount = useMemo(() => {
    if (tipPercent !== null) {
      return Math.round(cart.subtotal * tipPercent);
    }
    const custom = parseFloat(customTip);
    return isNaN(custom) ? 0 : Math.round(custom * 100);
  }, [tipPercent, customTip, cart.subtotal]);

  const deliveryFee = orderType === "delivery" ? DELIVERY_FEE : 0;
  const orderTotal = cart.subtotal + cart.tax + tipAmount + deliveryFee;

  // Keep form data saved for Cash App Pay redirect return (mobile)
  useEffect(() => {
    if (cashAppPayAvailable) {
      sessionStorage.setItem("proper_cashapp_form", JSON.stringify({
        name, phone, email, pickupTime, tipPercent, customTip
      }));
    }
  }, [name, phone, email, pickupTime, tipPercent, customTip, cashAppPayAvailable]);

  // Load Square Web Payments SDK
  const initSquare = useCallback(async () => {
    try {
      if (!(window as any).Square) return;

      const payments = (window as any).Square.payments(SQUARE_APP_ID, SQUARE_LOCATION_ID);
      paymentsRef.current = payments;

      // Initialize Card
      const card = await payments.card();
      await card.attach("#square-card-container");
      cardRef.current = card;
      setCardReady(true);

      // Initialize Apple Pay
      try {
        const applePayRequest = payments.paymentRequest({
          countryCode: "US",
          currencyCode: "USD",
          total: { amount: (orderTotal / 100).toFixed(2), label: "Proper Cuisine" },
        });
        const applePay = await payments.applePay(applePayRequest);
        if (applePay) {
          applePayRef.current = applePay;
          setApplePayAvailable(true);
        }
      } catch {
        // Apple Pay not available on this device/browser
      }

      // Initialize Cash App Pay
      try {
        const cashAppRequest = payments.paymentRequest({
          countryCode: "US",
          currencyCode: "USD",
          total: { amount: (orderTotal / 100).toFixed(2), label: "Proper Cuisine" },
        });
        const cashAppPay = await payments.cashAppPay(cashAppRequest, {
          redirectURL: window.location.href,
          referenceId: "proper-" + Date.now(),
        });
        if (cashAppPay) {
          await cashAppPay.attach("#cashapp-pay-container");
          cashAppPay.addEventListener("ontokenization", (event: any) => {
            const { tokenResult } = event.detail;
            if (tokenResult.status === "OK") {
              sessionStorage.removeItem("proper_cashapp_form");
              processOrderRef.current?.(tokenResult.token);
            } else if (tokenResult.status === "Cancel") {
              sessionStorage.removeItem("proper_cashapp_form");
            }
          });
          cashAppPayRef.current = cashAppPay;
          setCashAppPayAvailable(true);
        }
      } catch (e) {
        console.error("Cash App Pay init error:", e);
      }
    } catch (err: any) {
      console.error("Square init error:", err);
    }
  }, []);

  useEffect(() => {
    const existingScript = document.querySelector(
      'script[src="https://web.squarecdn.com/v1/square.js"]'
    );
    if (existingScript) {
      if ((window as any).Square) {
        initSquare();
      } else {
        existingScript.addEventListener("load", initSquare);
      }
      return;
    }

    const script = document.createElement("script");
    script.src = "https://web.squarecdn.com/v1/square.js";
    script.async = true;
    script.onload = () => initSquare();
    document.head.appendChild(script);

    return () => {
      if (cardRef.current) {
        try {
          cardRef.current.destroy();
        } catch {}
      }
    };
  }, [initSquare]);

  // Redirect if cart is empty
  if (cart.items.length === 0) {
    return (
      <div className="min-h-screen bg-[#0a0a0a]">
        <Navigation />
        <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
          <div className="w-24 h-24 rounded-3xl bg-gold/5 flex items-center justify-center mb-6">
            <ShoppingBag className="w-10 h-10 text-gold/20" />
          </div>
          <h1 className="font-display text-3xl text-pure-white mb-4">Your Cart is Empty</h1>
          <p className="text-cream/40 mb-8">Add some items before checking out.</p>
          <Button variant="gold" size="lg" className="rounded-xl" asChild>
            <Link to="/order">Browse Menu</Link>
          </Button>
        </div>
        <Footer />
      </div>
    );
  }

  const handleApplePay = async () => {
    if (!applePayRef.current) return;
    try {
      const result = await applePayRef.current.tokenize();
      if (result.status === "OK") {
        await processOrder(result.token);
      }
    } catch {
      toast({
        title: "Apple Pay Error",
        description: "Could not complete Apple Pay. Please try another method.",
        variant: "destructive",
      });
    }
  };

  const processOrder: (nonce: string | null) => Promise<void> = async (nonce) => {
    if (!name.trim() || !phone.trim() || !email.trim()) {
      toast({
        title: "Missing Information",
        description: "Please fill out your name, phone, and email.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const ORDER_API_URL = "https://examining-fit-finally-controlled.trycloudflare.com";

      const apiItems = cart.items.map((item) => ({
        variationId: item.variationId,
        quantity: item.quantity,
        modifiers: item.modifiers.map((m) => ({ modifierId: m.modifierId })),
        note: item.specialInstructions || undefined,
      }));

      const res = await fetch(ORDER_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: apiItems,
          customer: { name, phone, email },
          tip: tipAmount,
          deliveryFee,
          orderType,
          sourceId: nonce,
          pickupTime: pickupTime === "asap" ? "asap" : pickupTime,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Order failed");
      }

      const orderData = {
        confirmationNumber: result.confirmationNumber,
        orderId: result.orderId,
        paymentId: result.paymentId,
        items: cart.items,
        subtotal: cart.subtotal,
        tax: cart.tax,
        deliveryFee,
        tip: tipAmount,
        total: orderTotal,
        customer: { name, phone, email },
        pickupTime:
          pickupTime === "asap"
            ? "ASAP (20–30 min)"
            : pickupTimes.find((t) => t.value === pickupTime)?.label || "ASAP",
        createdAt: new Date().toISOString(),
      };
      sessionStorage.setItem("proper-order-confirmation", JSON.stringify(orderData));

      cart.clearCart();
      navigate("/order/confirmation");
    } catch {
      toast({
        title: "Order Failed",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Keep ref updated so Cash App callback uses latest closure
  processOrderRef.current = processOrder;

  const handleSubmit = async () => {
    if (!name.trim() || !phone.trim() || !email.trim()) {
      toast({
        title: "Missing Information",
        description: "Please fill out your name, phone, and email.",
        variant: "destructive",
      });
      return;
    }

    if (selectedPayment === "apple-pay") {
      await handleApplePay();
      return;
    }

    // For Cash App, the payment is handled via the Cash App button/redirect
    if (selectedPayment === "cashapp") {
      return;
    }

    setIsSubmitting(true);

    try {
      let nonce: string | null = null;

      if (cardRef.current && cardReady) {
        const result = await cardRef.current.tokenize();
        if (result.status === "OK") {
          nonce = result.token;
        } else {
          toast({
            title: "Payment Error",
            description:
              result.errors?.[0]?.message || "Could not process card. Please check your details.",
            variant: "destructive",
          });
          setIsSubmitting(false);
          return;
        }
      }

      await processOrder(nonce);
    } catch {
      toast({
        title: "Order Failed",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      <main className="pt-24 sm:pt-28 pb-32 sm:pb-40 px-3 sm:px-6">
        <div className="max-w-5xl mx-auto">
          {/* Back link */}
          <Link
            to="/order"
            className="inline-flex items-center gap-2 text-cream/40 hover:text-gold transition-colors mb-6 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Menu</span>
          </Link>

          <h1 className="font-display text-3xl sm:text-4xl font-bold text-pure-white mb-2">
            Checkout
          </h1>
          <div className="w-12 h-[2px] bg-gradient-to-r from-gold to-transparent rounded-full mb-8" />

          {/* Two-column layout: form left, summary right */}
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8 items-start">
            {/* ─── LEFT COLUMN: Form ─── */}
            <div className="w-full lg:flex-1 space-y-5 min-w-0">
              {/* ─── Customer Info ─── */}
              <section data-testid="customer-info-section" className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center">
                    <User className="w-4 h-4 text-gold" />
                  </div>
                  <h2 className="font-display text-lg text-pure-white font-medium">
                    Your Information
                  </h2>
                </div>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name" className="text-cream/50 text-sm mb-1.5 block">
                      Full Name
                    </Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="John Doe"
                      className="bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-12"
                    />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="phone" className="text-cream/50 text-sm mb-1.5 block">
                        Phone Number
                      </Label>
                      <div className="relative">
                        <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/25" />
                        <Input
                          id="phone"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="(443) 555-0123"
                          className="pl-10 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-12"
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="email" className="text-cream/50 text-sm mb-1.5 block">
                        Email
                      </Label>
                      <div className="relative">
                        <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/25" />
                        <Input
                          id="email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="john@email.com"
                          className="pl-10 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-12"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              {/* ─── Pickup Time ─── */}
              <section data-testid="pickup-time-section" className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center">
                    <Clock className="w-4 h-4 text-gold" />
                  </div>
                  <h2 className="font-display text-lg text-pure-white font-medium">
                    Pickup Time
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => setPickupTime("asap")}
                    className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 border ${
                      pickupTime === "asap"
                        ? "border-gold bg-gold/10 text-gold"
                        : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25"
                    }`}
                  >
                    ASAP
                    <span className="text-[11px] ml-1.5 opacity-60">20–30 min</span>
                  </button>
                  {pickupTimes.slice(0, 5).map((t) => (
                    <button
                      key={t.value}
                      onClick={() => setPickupTime(t.value)}
                      className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 border ${
                        pickupTime === t.value
                          ? "border-gold bg-gold/10 text-gold"
                          : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </section>

              {/* ─── Tip ─── */}
              <section data-testid="tip-section" className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center">
                    <Heart className="w-4 h-4 text-gold" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg text-pure-white font-medium">Add a Tip</h2>
                    <p className="text-cream/30 text-xs">Show appreciation for our team</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {TIP_OPTIONS.map((opt) => {
                    const isActive = tipPercent === opt.value;
                    return (
                      <button
                        key={opt.label}
                        onClick={() => {
                          setTipPercent(opt.value);
                          setCustomTip("");
                        }}
                        className={`relative py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 border ${
                          isActive
                            ? "border-gold bg-gold/10 text-gold shadow-[0_0_16px_rgba(197,168,106,0.1)]"
                            : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25 hover:text-cream"
                        }`}
                      >
                        {opt.label}
                        <span className="block text-[10px] font-normal mt-0.5 opacity-50">
                          {formatPrice(Math.round(cart.subtotal * opt.value))}
                        </span>
                        {isActive && (
                          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-gold flex items-center justify-center">
                            <Check className="w-2.5 h-2.5 text-jet-black" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setTipPercent(null)}
                    className={`py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 border ${
                      tipPercent === null
                        ? "border-gold bg-gold/10 text-gold shadow-[0_0_16px_rgba(197,168,106,0.1)]"
                        : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25 hover:text-cream"
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {tipPercent === null && (
                  <div className="relative mt-3">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-cream/25 font-medium">
                      $
                    </span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={customTip}
                      onChange={(e) => setCustomTip(e.target.value)}
                      placeholder="0.00"
                      className="pl-7 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-12"
                    />
                  </div>
                )}
              </section>

              {/* ─── Payment Method ─── */}
              <section data-testid="payment-section" className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-5 sm:p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center">
                    <CreditCard className="w-4 h-4 text-gold" />
                  </div>
                  <h2 className="font-display text-lg text-pure-white font-medium">Payment</h2>
                  <div className="ml-auto items-center gap-1.5 text-cream/25 text-xs hidden sm:flex">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Secured by Square</span>
                  </div>
                </div>

                {/* Payment method selector cards */}
                <div className="grid gap-2 mb-5" data-testid="payment-methods">
                  {/* Credit/Debit Card */}
                  <button
                    onClick={() => setSelectedPayment("card")}
                    className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-200 text-left ${
                      selectedPayment === "card"
                        ? "border-gold bg-gold/5 ring-1 ring-gold/20"
                        : "border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]"
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      selectedPayment === "card" ? "bg-gold/15" : "bg-[#1e1e1e]"
                    }`}>
                      <CreditCard className={`w-5 h-5 ${selectedPayment === "card" ? "text-gold" : "text-cream/40"}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium ${selectedPayment === "card" ? "text-pure-white" : "text-cream/70"}`}>
                        Credit / Debit Card
                      </p>
                      <p className="text-xs text-cream/30">Visa, Mastercard, Amex</p>
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                      selectedPayment === "card" ? "border-gold bg-gold" : "border-[#3a3a3a]"
                    }`}>
                      {selectedPayment === "card" && <Check className="w-3 h-3 text-jet-black" />}
                    </div>
                  </button>

                  {/* Apple Pay */}
                  {applePayAvailable && (
                    <button
                      onClick={() => setSelectedPayment("apple-pay")}
                      className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-200 text-left ${
                        selectedPayment === "apple-pay"
                          ? "border-gold bg-gold/5 ring-1 ring-gold/20"
                          : "border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]"
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                        selectedPayment === "apple-pay" ? "bg-gold/15" : "bg-[#1e1e1e]"
                      }`}>
                        <Apple className={`w-5 h-5 ${selectedPayment === "apple-pay" ? "text-gold" : "text-cream/40"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${selectedPayment === "apple-pay" ? "text-pure-white" : "text-cream/70"}`}>
                          Apple Pay
                        </p>
                        <p className="text-xs text-cream/30">Pay with Face ID or Touch ID</p>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        selectedPayment === "apple-pay" ? "border-gold bg-gold" : "border-[#3a3a3a]"
                      }`}>
                        {selectedPayment === "apple-pay" && <Check className="w-3 h-3 text-jet-black" />}
                      </div>
                    </button>
                  )}

                  {/* Cash App Pay */}
                  {cashAppPayAvailable && (
                    <button
                      onClick={() => setSelectedPayment("cashapp")}
                      className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-200 text-left ${
                        selectedPayment === "cashapp"
                          ? "border-gold bg-gold/5 ring-1 ring-gold/20"
                          : "border-[#2a2a2a] bg-[#141414] hover:border-[#3a3a3a]"
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                        selectedPayment === "cashapp" ? "bg-gold/15" : "bg-[#1e1e1e]"
                      }`}>
                        <Banknote className={`w-5 h-5 ${selectedPayment === "cashapp" ? "text-gold" : "text-cream/40"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium ${selectedPayment === "cashapp" ? "text-pure-white" : "text-cream/70"}`}>
                          Cash App Pay
                        </p>
                        <p className="text-xs text-cream/30">Pay with your Cash App balance</p>
                      </div>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        selectedPayment === "cashapp" ? "border-gold bg-gold" : "border-[#3a3a3a]"
                      }`}>
                        {selectedPayment === "cashapp" && <Check className="w-3 h-3 text-jet-black" />}
                      </div>
                    </button>
                  )}
                </div>

                {/* Card input — visible when card is selected */}
                <div className={selectedPayment === "card" ? "block" : "hidden"}>
                  <div
                    id="square-card-container"
                    className="min-h-[100px] rounded-xl overflow-hidden"
                    style={{ colorScheme: "dark" }}
                  />
                </div>

                {/* Cash App container — hidden, attached by SDK */}
                <div
                  id="cashapp-pay-container"
                  className="w-full rounded-xl overflow-hidden [&>div]:!w-full [&>div>button]:!w-full [&>div>button]:!border-0 [&>div>button]:!rounded-xl [&>div>button]:!h-12"
                  style={{
                    minHeight: selectedPayment === "cashapp" && cashAppPayAvailable ? "48px" : "0",
                    overflow: selectedPayment === "cashapp" && cashAppPayAvailable ? "visible" : "hidden",
                    opacity: selectedPayment === "cashapp" && cashAppPayAvailable ? 1 : 0,
                    position: selectedPayment === "cashapp" && cashAppPayAvailable ? "relative" : "absolute",
                    pointerEvents: selectedPayment === "cashapp" && cashAppPayAvailable ? "auto" : "none",
                  }}
                />
              </section>
            </div>

            {/* ─── RIGHT COLUMN: Order Summary Sidebar ─── */}
            <div className="w-full lg:w-[380px] lg:shrink-0" data-testid="order-summary-sidebar">
              <div className="lg:sticky lg:top-28">
                <section className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-5 sm:p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center">
                      <ShoppingBag className="w-4 h-4 text-gold" />
                    </div>
                    <h2 className="font-display text-lg text-pure-white font-medium">
                      Order Summary
                    </h2>
                    <span className="ml-auto text-cream/30 text-sm">
                      {cart.items.reduce((s, i) => s + i.quantity, 0)} items
                    </span>
                  </div>

                  {/* Cart items with quantity controls */}
                  <div className="space-y-0 mb-5" data-testid="order-items">
                    {cart.items.map((item) => {
                      const modTotal = item.modifiers.reduce((s, m) => s + m.price, 0);
                      const lineTotal = (item.basePrice + modTotal) * item.quantity;
                      return (
                        <div
                          key={item.cartItemId}
                          className="py-3 border-b border-[#1a1a1a] last:border-0"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-cream text-sm font-medium">{item.name}</p>
                              {item.modifiers.length > 0 && (
                                <div className="mt-0.5">
                                  {item.modifiers.map((m) => (
                                    <p key={m.modifierId} className="text-cream/25 text-xs">
                                      + {m.modifierName}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                            <span className="text-cream/60 text-sm font-medium whitespace-nowrap">
                              {formatPrice(lineTotal)}
                            </span>
                          </div>
                          {/* Quantity controls */}
                          <div className="flex items-center gap-2 mt-2">
                            <div className="flex items-center gap-0 bg-[#1a1a1a] rounded-lg border border-[#2a2a2a]">
                              <button
                                onClick={() => cart.updateQuantity(item.cartItemId, item.quantity - 1)}
                                className="w-7 h-7 flex items-center justify-center text-cream/40 hover:text-cream transition-colors"
                                aria-label={`Decrease quantity of ${item.name}`}
                              >
                                {item.quantity === 1 ? (
                                  <Trash2 className="w-3 h-3 text-red-400/60" />
                                ) : (
                                  <Minus className="w-3 h-3" />
                                )}
                              </button>
                              <span className="w-7 text-center text-xs text-cream font-medium">
                                {item.quantity}
                              </span>
                              <button
                                onClick={() => cart.updateQuantity(item.cartItemId, item.quantity + 1)}
                                className="w-7 h-7 flex items-center justify-center text-cream/40 hover:text-cream transition-colors"
                                aria-label={`Increase quantity of ${item.name}`}
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <Link
                    to="/order"
                    className="text-gold/60 hover:text-gold text-xs font-medium transition-colors inline-flex items-center gap-1 mb-5"
                  >
                    <Plus className="w-3 h-3" />
                    Add more items
                  </Link>

                  {/* Totals */}
                  <div className="border-t border-[#1e1e1e] pt-4 space-y-2.5 text-sm">
                    <div className="flex justify-between text-cream/40">
                      <span>Subtotal</span>
                      <span className="text-cream/60">{formatPrice(cart.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-cream/40">
                      <span>Tax</span>
                      <span className="text-cream/60">{formatPrice(cart.tax)}</span>
                    </div>
                    {deliveryFee > 0 && (
                      <>
                        <div className="flex justify-between text-cream/40">
                          <span>Delivery Fee</span>
                          <span className="text-cream/60">{formatPrice(deliveryFee)}</span>
                        </div>
                        <div className="flex justify-between text-cream/40" data-testid="estimated-delivery-time">
                          <span>Est. Delivery</span>
                          <span className="text-cream/60">{ESTIMATED_DELIVERY_TIME}</span>
                        </div>
                      </>
                    )}
                    {tipAmount > 0 && (
                      <div className="flex justify-between text-cream/40">
                        <span>Tip</span>
                        <span className="text-cream/60">{formatPrice(tipAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-3 mt-1 border-t border-[#1e1e1e]">
                      <span className="text-pure-white font-semibold text-base">Total</span>
                      <span className="text-gold font-display font-bold text-xl">
                        {formatPrice(orderTotal)}
                      </span>
                    </div>
                  </div>

                  {/* Place Order button — desktop (inside sidebar) */}
                  <div className="hidden lg:block mt-5">
                    <button
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                      className="w-full h-14 rounded-2xl font-semibold text-base transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-[#C5A86A] to-[#D4BC7C] text-[#1C1C1C] border border-[#C5A86A]/50 hover:shadow-[0_8px_32px_-8px_rgba(197,168,106,0.4)] hover:-translate-y-0.5 active:scale-[0.99]"
                    >
                      {isSubmitting ? (
                        <span className="flex items-center justify-center gap-2.5">
                          <span className="w-5 h-5 border-2 border-[#1C1C1C]/30 border-t-[#1C1C1C] rounded-full animate-spin" />
                          Processing...
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">
                          Place Order
                          <span className="opacity-60">—</span>
                          <span className="font-bold">{formatPrice(orderTotal)}</span>
                        </span>
                      )}
                    </button>
                    <p className="text-cream/15 text-[10px] text-center mt-2">
                      Pickup at 206 E Redwood St, Baltimore
                    </p>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ─── STICKY PLACE ORDER BAR — mobile only ─── */}
      <div className="fixed bottom-0 left-0 right-0 z-50 lg:hidden">
        <div className="bg-[#0a0a0a]/80 backdrop-blur-xl border-t border-[#1e1e1e]">
          <div className="max-w-2xl mx-auto px-4 py-4">
            <button
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="w-full h-14 rounded-2xl font-semibold text-base transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed bg-gradient-to-r from-[#C5A86A] to-[#D4BC7C] text-[#1C1C1C] border border-[#C5A86A]/50 hover:shadow-[0_8px_32px_-8px_rgba(197,168,106,0.4)] hover:-translate-y-0.5 active:scale-[0.99]"
            >
              {isSubmitting ? (
                <span className="flex items-center justify-center gap-2.5">
                  <span className="w-5 h-5 border-2 border-[#1C1C1C]/30 border-t-[#1C1C1C] rounded-full animate-spin" />
                  Processing...
                </span>
              ) : (
                <span className="flex items-center justify-center gap-2">
                  Place Order
                  <span className="opacity-60">—</span>
                  <span className="font-bold">{formatPrice(orderTotal)}</span>
                </span>
              )}
            </button>
            <p className="text-cream/15 text-[10px] text-center mt-2">
              Pickup at 206 E Redwood St, Baltimore
            </p>
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default OrderCheckout;
