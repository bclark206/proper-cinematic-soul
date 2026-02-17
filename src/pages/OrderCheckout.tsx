import { useState, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent } from "@/components/ui/card";
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
  AlertCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const TIP_OPTIONS = [
  { label: "15%", value: 0.15 },
  { label: "20%", value: 0.20 },
  { label: "25%", value: 0.25 },
];

function generatePickupTimes(): { label: string; value: string }[] {
  const now = new Date();
  const times: { label: string; value: string }[] = [];
  // Start at 20 minutes from now, then every 15 min for 2 hours
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

  const pickupTimes = useMemo(() => generatePickupTimes(), []);

  const tipAmount = useMemo(() => {
    if (tipPercent !== null) {
      return Math.round(cart.subtotal * tipPercent);
    }
    const custom = parseFloat(customTip);
    return isNaN(custom) ? 0 : Math.round(custom * 100);
  }, [tipPercent, customTip, cart.subtotal]);

  const orderTotal = cart.subtotal + cart.tax + tipAmount;

  // Redirect if cart is empty
  if (cart.items.length === 0) {
    return (
      <div className="min-h-screen bg-jet-black">
        <Navigation />
        <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
          <ShoppingBag className="w-20 h-20 text-gold/20 mb-6" />
          <h1 className="font-display text-3xl text-pure-white mb-4">Your Cart is Empty</h1>
          <p className="text-cream/50 mb-8">Add some items before checking out.</p>
          <Button variant="gold" size="lg" asChild>
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
      // In production, this would call the /api/create-order endpoint
      // For MVP, we simulate the order creation
      await new Promise((r) => setTimeout(r, 2000));

      const confirmationNumber = `PC-${Date.now().toString(36).toUpperCase()}`;

      // Store order data for confirmation page
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
    <div className="min-h-screen bg-jet-black">
      <Navigation />

      <main className="pt-28 pb-16 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          {/* Back link */}
          <Link
            to="/order"
            className="inline-flex items-center gap-2 text-cream/50 hover:text-gold transition-colors mb-8"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Menu</span>
          </Link>

          <h1 className="font-display text-3xl sm:text-4xl font-bold text-pure-white mb-2">
            Checkout
          </h1>
          <div className="w-16 h-0.5 bg-gradient-to-r from-gold to-transparent rounded-full mb-10"></div>

          <div className="grid lg:grid-cols-5 gap-8">
            {/* Left Column — Form */}
            <div className="lg:col-span-3 space-y-8">
              {/* Customer Info */}
              <Card className="bg-[#1a1a1a] border-gold/10">
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 mb-6">
                    <User className="w-5 h-5 text-gold" />
                    <h2 className="font-display text-xl text-pure-white">
                      Your Information
                    </h2>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="name" className="text-cream/60 text-sm">
                        Full Name
                      </Label>
                      <Input
                        id="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="John Doe"
                        className="mt-1 bg-gold/5 border-gold/10 text-cream placeholder:text-cream/30 focus:border-gold/40"
                      />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="phone" className="text-cream/60 text-sm">
                          Phone Number
                        </Label>
                        <div className="relative mt-1">
                          <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/30" />
                          <Input
                            id="phone"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="(443) 555-0123"
                            className="pl-10 bg-gold/5 border-gold/10 text-cream placeholder:text-cream/30 focus:border-gold/40"
                          />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="email" className="text-cream/60 text-sm">
                          Email
                        </Label>
                        <div className="relative mt-1">
                          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cream/30" />
                          <Input
                            id="email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="john@email.com"
                            className="pl-10 bg-gold/5 border-gold/10 text-cream placeholder:text-cream/30 focus:border-gold/40"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Pickup Time */}
              <Card className="bg-[#1a1a1a] border-gold/10">
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 mb-6">
                    <Clock className="w-5 h-5 text-gold" />
                    <h2 className="font-display text-xl text-pure-white">
                      Pickup Time
                    </h2>
                  </div>
                  <RadioGroup
                    value={pickupTime}
                    onValueChange={setPickupTime}
                    className="space-y-2"
                  >
                    <div className="flex items-center space-x-3 p-3 rounded-lg border border-gold/10 hover:border-gold/20 transition-colors">
                      <RadioGroupItem value="asap" id="asap" className="border-gold/40 text-gold" />
                      <Label htmlFor="asap" className="text-cream cursor-pointer flex-1">
                        ASAP <span className="text-cream/40 text-sm">(20–30 minutes)</span>
                      </Label>
                    </div>
                    {pickupTimes.map((t) => (
                      <div
                        key={t.value}
                        className="flex items-center space-x-3 p-3 rounded-lg border border-gold/10 hover:border-gold/20 transition-colors"
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
                </CardContent>
              </Card>

              {/* Tip */}
              <Card className="bg-[#1a1a1a] border-gold/10">
                <CardContent className="p-6">
                  <h2 className="font-display text-xl text-pure-white mb-4">
                    Add a Tip
                  </h2>
                  <div className="grid grid-cols-4 gap-2 mb-4">
                    {TIP_OPTIONS.map((opt) => (
                      <button
                        key={opt.label}
                        onClick={() => {
                          setTipPercent(opt.value);
                          setCustomTip("");
                        }}
                        className={`py-3 rounded-lg text-sm font-medium transition-all duration-200 border ${
                          tipPercent === opt.value
                            ? "border-gold bg-gold/15 text-gold"
                            : "border-gold/10 text-cream/60 hover:border-gold/30"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                    <button
                      onClick={() => setTipPercent(null)}
                      className={`py-3 rounded-lg text-sm font-medium transition-all duration-200 border ${
                        tipPercent === null
                          ? "border-gold bg-gold/15 text-gold"
                          : "border-gold/10 text-cream/60 hover:border-gold/30"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                  {tipPercent === null && (
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cream/30">$</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={customTip}
                        onChange={(e) => setCustomTip(e.target.value)}
                        placeholder="0.00"
                        className="pl-7 bg-gold/5 border-gold/10 text-cream placeholder:text-cream/30 focus:border-gold/40"
                      />
                    </div>
                  )}
                  <p className="text-cream/30 text-xs mt-3">
                    Tip: {formatPrice(tipAmount)}
                  </p>
                </CardContent>
              </Card>

              {/* Payment - Placeholder for Square Web Payments SDK */}
              <Card className="bg-[#1a1a1a] border-gold/10">
                <CardContent className="p-6">
                  <div className="flex items-center gap-2 mb-6">
                    <CreditCard className="w-5 h-5 text-gold" />
                    <h2 className="font-display text-xl text-pure-white">
                      Payment
                    </h2>
                  </div>
                  <div className="bg-gold/5 border border-gold/10 rounded-xl p-6 text-center">
                    <AlertCircle className="w-8 h-8 text-gold/40 mx-auto mb-3" />
                    <p className="text-cream/50 text-sm mb-1">
                      Square Web Payments SDK
                    </p>
                    <p className="text-cream/30 text-xs">
                      Secure card form will load here. For now, orders are submitted for kitchen prep. Payment will be collected at pickup.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right Column — Order Summary */}
            <div className="lg:col-span-2">
              <div className="sticky top-28">
                <Card className="bg-[#1a1a1a] border-gold/10">
                  <CardContent className="p-6">
                    <h2 className="font-display text-xl text-pure-white mb-6">
                      Order Summary
                    </h2>

                    <div className="space-y-4 mb-6 max-h-[40vh] overflow-y-auto pr-1">
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
                            className="flex justify-between gap-3 pb-3 border-b border-gold/5"
                          >
                            <div className="min-w-0">
                              <p className="text-cream text-sm font-medium">
                                {item.quantity}x {item.name}
                              </p>
                              {item.modifiers.map((m) => (
                                <p
                                  key={m.modifierId}
                                  className="text-cream/30 text-xs"
                                >
                                  + {m.modifierName}
                                </p>
                              ))}
                            </div>
                            <span className="text-cream/70 text-sm whitespace-nowrap">
                              {formatPrice(lineTotal)}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between text-cream/50">
                        <span>Subtotal</span>
                        <span>{formatPrice(cart.subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-cream/50">
                        <span>Tax (6%)</span>
                        <span>{formatPrice(cart.tax)}</span>
                      </div>
                      <div className="flex justify-between text-cream/50">
                        <span>Tip</span>
                        <span>{formatPrice(tipAmount)}</span>
                      </div>
                      <div className="flex justify-between text-pure-white font-semibold text-base border-t border-gold/10 pt-3">
                        <span>Total</span>
                        <span className="text-gold">
                          {formatPrice(orderTotal)}
                        </span>
                      </div>
                    </div>

                    <Button
                      variant="gold"
                      size="lg"
                      className="w-full mt-6 text-base"
                      onClick={handleSubmit}
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-4 h-4 border-2 border-jet-black/30 border-t-jet-black rounded-full animate-spin" />
                          Placing Order...
                        </span>
                      ) : (
                        `Place Order — ${formatPrice(orderTotal)}`
                      )}
                    </Button>

                    <p className="text-cream/20 text-[11px] text-center mt-4">
                      206 E Redwood St, Baltimore, MD 21202
                    </p>
                  </CardContent>
                </Card>
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
