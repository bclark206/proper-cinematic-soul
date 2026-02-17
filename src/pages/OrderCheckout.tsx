import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCart } from "@/hooks/useCart";
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const SQUARE_APP_ID = "sq0idp-ckcAIc_AeKVuekaXP7rBSA";
const SQUARE_LOCATION_ID = "LPPWSSV03BHK8";

const TIP_OPTIONS = [
  { label: "15%", value: 0.15 },
  { label: "20%", value: 0.20 },
  { label: "25%", value: 0.25 },
];

function generatePickupTimes(): { label: string; value: string }[] {
  const now = new Date();
  const times: { label: string; value: string }[] = [];
  const startMin = 20;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + (startMin + i * 15) * 60000);
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

const OrderCheckout = () => {
  const cart = useCart();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pickupTime, setPickupTime] = useState("asap");
  const [tipPercent, setTipPercent] = useState<number | null>(0.20);
  const [customTip, setCustomTip] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cardReady, setCardReady] = useState(false);
  const [squareError, setSquareError] = useState<string | null>(null);

  const cardRef = useRef<any>(null);
  const paymentsRef = useRef<any>(null);

  const pickupTimes = useMemo(() => generatePickupTimes(), []);

  const tipAmount = useMemo(() => {
    if (tipPercent !== null) {
      return Math.round(cart.subtotal * tipPercent);
    }
    const custom = parseFloat(customTip);
    return isNaN(custom) ? 0 : Math.round(custom * 100);
  }, [tipPercent, customTip, cart.subtotal]);

  const orderTotal = cart.subtotal + cart.tax + tipAmount;

  // Load Square Web Payments SDK
  const initSquare = useCallback(async () => {
    try {
      if (!(window as any).Square) {
        setSquareError("Square payments is loading...");
        return;
      }

      const payments = (window as any).Square.payments(SQUARE_APP_ID, SQUARE_LOCATION_ID);
      paymentsRef.current = payments;

      const card = await payments.card();
      await card.attach("#square-card-container");
      cardRef.current = card;
      setCardReady(true);
      setSquareError(null);
    } catch (err: any) {
      console.error("Square init error:", err);
      setSquareError("Could not load payment form. Please refresh and try again.");
    }
  }, []);

  useEffect(() => {
    // Load Square JS SDK script
    const existingScript = document.querySelector('script[src="https://web.squarecdn.com/v1/square.js"]');
    if (existingScript) {
      // Script already loaded, init directly
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
    script.onerror = () => setSquareError("Failed to load payment system. Please refresh.");
    document.head.appendChild(script);

    return () => {
      if (cardRef.current) {
        try { cardRef.current.destroy(); } catch {}
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

  const handleSubmit = async () => {
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
      let nonce: string | null = null;

      // Tokenize card if ready
      if (cardRef.current && cardReady) {
        const result = await cardRef.current.tokenize();
        if (result.status === "OK") {
          nonce = result.token;
        } else {
          toast({
            title: "Payment Error",
            description: result.errors?.[0]?.message || "Could not process card. Please check your details.",
            variant: "destructive",
          });
          setIsSubmitting(false);
          return;
        }
      }

      // In production, send nonce + order to /api/create-order
      // For now, simulate order creation
      await new Promise((r) => setTimeout(r, 2000));

      const confirmationNumber = `PC-${Date.now().toString(36).toUpperCase()}`;

      const orderData = {
        confirmationNumber,
        items: cart.items,
        subtotal: cart.subtotal,
        tax: cart.tax,
        tip: tipAmount,
        total: orderTotal,
        customer: { name, phone, email },
        pickupTime: pickupTime === "asap" ? "ASAP (20–30 min)" : pickupTimes.find(t => t.value === pickupTime)?.label || "ASAP",
        createdAt: new Date().toISOString(),
        paymentNonce: nonce,
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

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      <main className="pt-28 pb-16 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          {/* Back link */}
          <Link
            to="/order"
            className="inline-flex items-center gap-2 text-cream/40 hover:text-gold transition-colors mb-8 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Menu</span>
          </Link>

          <h1 className="font-display text-3xl sm:text-4xl font-bold text-pure-white mb-2">
            Checkout
          </h1>
          <div className="w-12 h-[2px] bg-gradient-to-r from-gold to-transparent rounded-full mb-10" />

          <div className="grid lg:grid-cols-5 gap-8">
            {/* Left Column — Form */}
            <div className="lg:col-span-3 space-y-6">
              {/* Customer Info */}
              <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-9 h-9 rounded-xl bg-gold/10 flex items-center justify-center">
                    <User className="w-4.5 h-4.5 text-gold" />
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
                      className="bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-11"
                    />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="phone" className="text-cream/50 text-sm mb-1.5 block">
                        Phone Number
                      </Label>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/25" />
                        <Input
                          id="phone"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="(443) 555-0123"
                          className="pl-10 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-11"
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="email" className="text-cream/50 text-sm mb-1.5 block">
                        Email
                      </Label>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/25" />
                        <Input
                          id="email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="john@email.com"
                          className="pl-10 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-11"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Pickup Time */}
              <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-9 h-9 rounded-xl bg-gold/10 flex items-center justify-center">
                    <Clock className="w-4.5 h-4.5 text-gold" />
                  </div>
                  <h2 className="font-display text-lg text-pure-white font-medium">
                    Pickup Time
                  </h2>
                </div>
                <RadioGroup
                  value={pickupTime}
                  onValueChange={setPickupTime}
                  className="space-y-2"
                >
                  <div className="flex items-center space-x-3 p-3.5 rounded-xl border border-[#2a2a2a] hover:border-gold/20 transition-colors bg-[#141414]">
                    <RadioGroupItem value="asap" id="asap" className="border-gold/40 text-gold" />
                    <Label htmlFor="asap" className="text-cream cursor-pointer flex-1">
                      ASAP <span className="text-cream/30 text-sm">(20–30 minutes)</span>
                    </Label>
                  </div>
                  {pickupTimes.map((t) => (
                    <div
                      key={t.value}
                      className="flex items-center space-x-3 p-3.5 rounded-xl border border-[#2a2a2a] hover:border-gold/20 transition-colors bg-[#141414]"
                    >
                      <RadioGroupItem
                        value={t.value}
                        id={t.value}
                        className="border-gold/40 text-gold"
                      />
                      <Label htmlFor={t.value} className="text-cream cursor-pointer flex-1">
                        {t.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              {/* Tip */}
              <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-9 h-9 rounded-xl bg-gold/10 flex items-center justify-center">
                    <Heart className="w-4.5 h-4.5 text-gold" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg text-pure-white font-medium">
                      Add a Tip
                    </h2>
                    <p className="text-cream/30 text-xs mt-0.5">Show your appreciation for our team</p>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2 mb-4">
                  {TIP_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => {
                        setTipPercent(opt.value);
                        setCustomTip("");
                      }}
                      className={`py-3 rounded-xl text-sm font-medium transition-all duration-200 border ${
                        tipPercent === opt.value
                          ? "border-gold bg-gold/10 text-gold shadow-[0_0_12px_rgba(197,168,106,0.1)]"
                          : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25 hover:text-cream"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setTipPercent(null)}
                    className={`py-3 rounded-xl text-sm font-medium transition-all duration-200 border ${
                      tipPercent === null
                        ? "border-gold bg-gold/10 text-gold shadow-[0_0_12px_rgba(197,168,106,0.1)]"
                        : "border-[#2a2a2a] bg-[#141414] text-cream/50 hover:border-gold/25 hover:text-cream"
                    }`}
                  >
                    Custom
                  </button>
                </div>
                {tipPercent === null && (
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cream/25 font-medium">$</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={customTip}
                      onChange={(e) => setCustomTip(e.target.value)}
                      placeholder="0.00"
                      className="pl-7 bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-11"
                    />
                  </div>
                )}
                <p className="text-cream/25 text-xs mt-3">
                  Tip: {formatPrice(tipAmount)}
                </p>
              </div>

              {/* Payment — Square Web Payments SDK */}
              <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-9 h-9 rounded-xl bg-gold/10 flex items-center justify-center">
                    <CreditCard className="w-4.5 h-4.5 text-gold" />
                  </div>
                  <div className="flex-1">
                    <h2 className="font-display text-lg text-pure-white font-medium">
                      Payment
                    </h2>
                  </div>
                  <div className="flex items-center gap-1.5 text-cream/25 text-xs">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Secured by Square</span>
                  </div>
                </div>

                {/* Square Card Container */}
                <div
                  id="square-card-container"
                  className="min-h-[100px] rounded-xl overflow-hidden"
                  style={{ colorScheme: "dark" }}
                />

                {squareError && (
                  <p className="text-amber-400/60 text-xs mt-3 text-center">
                    {squareError}
                  </p>
                )}

                {cardReady && (
                  <p className="text-green-400/50 text-xs mt-3 text-center flex items-center justify-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400/60" />
                    Card form ready
                  </p>
                )}
              </div>
            </div>

            {/* Right Column — Order Summary */}
            <div className="lg:col-span-2">
              <div className="sticky top-28">
                <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl overflow-hidden">
                  <div className="p-6">
                    <h2 className="font-display text-lg text-pure-white font-medium mb-6">
                      Order Summary
                    </h2>

                    <div className="space-y-3 mb-6 max-h-[40vh] overflow-y-auto pr-1">
                      {cart.items.map((item) => {
                        const modTotal = item.modifiers.reduce(
                          (s, m) => s + m.price,
                          0
                        );
                        const lineTotal =
                          (item.basePrice + modTotal) * item.quantity;
                        return (
                          <div
                            key={item.cartItemId}
                            className="flex justify-between gap-3 pb-3 border-b border-[#1e1e1e]"
                          >
                            <div className="min-w-0">
                              <p className="text-cream text-sm font-medium">
                                {item.quantity}x {item.name}
                              </p>
                              {item.modifiers.map((m) => (
                                <p
                                  key={m.modifierId}
                                  className="text-cream/25 text-xs"
                                >
                                  + {m.modifierName}
                                </p>
                              ))}
                            </div>
                            <span className="text-cream/60 text-sm whitespace-nowrap">
                              {formatPrice(lineTotal)}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="space-y-2.5 text-sm">
                      <div className="flex justify-between text-cream/40">
                        <span>Subtotal</span>
                        <span className="text-cream/60">{formatPrice(cart.subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-cream/40">
                        <span>Tax (6%)</span>
                        <span className="text-cream/60">{formatPrice(cart.tax)}</span>
                      </div>
                      <div className="flex justify-between text-cream/40">
                        <span>Tip</span>
                        <span className="text-cream/60">{formatPrice(tipAmount)}</span>
                      </div>
                      <div className="flex justify-between text-pure-white font-semibold text-lg border-t border-[#1e1e1e] pt-3 mt-1">
                        <span>Total</span>
                        <span className="text-gold font-display">
                          {formatPrice(orderTotal)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Place Order Button */}
                  <div className="px-6 pb-6">
                    <Button
                      variant="gold"
                      size="lg"
                      className="w-full text-base font-semibold rounded-xl h-14 text-lg"
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <span className="flex items-center gap-2.5">
                          <span className="w-5 h-5 border-2 border-jet-black/30 border-t-jet-black rounded-full animate-spin" />
                          Processing...
                        </span>
                      ) : (
                        `Place Order — ${formatPrice(orderTotal)}`
                      )}
                    </Button>

                    <p className="text-cream/15 text-[11px] text-center mt-4">
                      206 E Redwood St, Baltimore, MD 21202
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default OrderCheckout;
