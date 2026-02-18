import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/data/menu";
import {
  CheckCircle,
  Clock,
  MapPin,
  Phone,
  ChefHat,
  ArrowRight,
  Copy,
} from "lucide-react";

interface OrderData {
  confirmationNumber: string;
  items: Array<{
    name: string;
    quantity: number;
    basePrice: number;
    modifiers: Array<{ modifierName: string; price: number }>;
  }>;
  subtotal: number;
  tax: number;
  deliveryFee?: number;
  tip: number;
  total: number;
  customer: { name: string; phone: string; email: string };
  pickupTime: string;
  createdAt: string;
}

const OrderConfirmation = () => {
  const [order, setOrder] = useState<OrderData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const data = sessionStorage.getItem("proper-order-confirmation");
      if (data) {
        setOrder(JSON.parse(data));
      }
    } catch {
      // ignore
    }
  }, []);

  const copyOrderNumber = () => {
    if (order) {
      navigator.clipboard.writeText(order.confirmationNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!order) {
    return (
      <div className="min-h-screen bg-[#0a0a0a]">
        <Navigation />
        <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
          <h1 className="font-display text-3xl text-pure-white mb-4">
            No Order Found
          </h1>
          <p className="text-cream/40 mb-8">
            It looks like you haven&apos;t placed an order yet.
          </p>
          <Button variant="gold" size="lg" className="rounded-xl" asChild>
            <Link to="/order">Browse Menu</Link>
          </Button>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <Navigation />

      <main className="pt-28 pb-16 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          {/* Success Header */}
          <div className="text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gold/10 mb-6 fade-in-up">
              <CheckCircle className="w-10 h-10 text-gold" />
            </div>
            <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-pure-white mb-4 fade-in-up">
              Order <span className="text-gold">Confirmed!</span>
            </h1>
            <div className="w-20 h-[2px] bg-gradient-to-r from-transparent via-gold to-transparent mx-auto mb-6" />
            <div className="inline-flex items-center gap-2 bg-gold/8 text-gold px-5 py-2.5 rounded-full fade-in-slow border border-gold/15">
              <ChefHat className="w-5 h-5" />
              <span className="font-medium text-sm">Your order has been sent to the kitchen!</span>
            </div>
          </div>

          {/* Order Number */}
          <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6 mb-5 text-center">
            <p className="text-cream/35 text-sm mb-2">Order Number</p>
            <div className="flex items-center justify-center gap-3">
              <p className="font-display text-3xl font-bold text-gold tracking-wider">
                {order.confirmationNumber}
              </p>
              <button
                onClick={copyOrderNumber}
                className="text-cream/25 hover:text-gold transition-colors p-1.5 rounded-lg hover:bg-gold/10"
                title="Copy order number"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            {copied && (
              <p className="text-gold/50 text-xs mt-2">Copied!</p>
            )}
          </div>

          {/* Pickup Info */}
          <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6 mb-5">
            <div className="grid sm:grid-cols-3 gap-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center shrink-0">
                  <Clock className="w-5 h-5 text-gold" />
                </div>
                <div>
                  <p className="text-cream/35 text-xs">Pickup Time</p>
                  <p className="text-cream font-medium">{order.pickupTime}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center shrink-0">
                  <MapPin className="w-5 h-5 text-gold" />
                </div>
                <div>
                  <p className="text-cream/35 text-xs">Pickup Location</p>
                  <p className="text-cream font-medium text-sm">206 E Redwood St</p>
                  <p className="text-cream/40 text-xs">Baltimore, MD 21202</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gold/10 flex items-center justify-center shrink-0">
                  <Phone className="w-5 h-5 text-gold" />
                </div>
                <div>
                  <p className="text-cream/35 text-xs">Questions?</p>
                  <p className="text-cream font-medium">(443) 432-2771</p>
                </div>
              </div>
            </div>
          </div>

          {/* Order Summary */}
          <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6 mb-5">
            <h2 className="font-display text-lg text-pure-white font-medium mb-5">
              Order Summary
            </h2>
            <div className="space-y-3 mb-6">
              {order.items.map((item, idx) => {
                const modTotal = item.modifiers.reduce(
                  (s, m) => s + m.price,
                  0
                );
                const lineTotal = (item.basePrice + modTotal) * item.quantity;
                return (
                  <div
                    key={idx}
                    className="flex justify-between gap-3 pb-3 border-b border-[#1e1e1e]"
                  >
                    <div>
                      <p className="text-cream text-sm">
                        {item.quantity}x {item.name}
                      </p>
                      {item.modifiers.map((m, mi) => (
                        <p key={mi} className="text-cream/25 text-xs">
                          + {m.modifierName}
                        </p>
                      ))}
                    </div>
                    <span className="text-cream/50 text-sm whitespace-nowrap">
                      {formatPrice(lineTotal)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-cream/40">
                <span>Subtotal</span>
                <span className="text-cream/60">{formatPrice(order.subtotal)}</span>
              </div>
              <div className="flex justify-between text-cream/40">
                <span>Tax</span>
                <span className="text-cream/60">{formatPrice(order.tax)}</span>
              </div>
              {order.deliveryFee != null && order.deliveryFee > 0 && (
                <div className="flex justify-between text-cream/40">
                  <span>Delivery Fee</span>
                  <span className="text-cream/60">{formatPrice(order.deliveryFee)}</span>
                </div>
              )}
              <div className="flex justify-between text-cream/40">
                <span>Tip</span>
                <span className="text-cream/60">{formatPrice(order.tip)}</span>
              </div>
              <div className="flex justify-between font-semibold text-lg border-t border-[#1e1e1e] pt-3">
                <span className="text-pure-white">Total</span>
                <span className="text-gold font-display">{formatPrice(order.total)}</span>
              </div>
            </div>
          </div>

          {/* Map Link */}
          <div className="bg-[#111111] border border-[#1e1e1e] rounded-2xl p-6 mb-8 text-center">
            <p className="text-cream/40 text-sm mb-3">
              Get directions to Proper Cuisine
            </p>
            <Button variant="outline-gold" className="rounded-xl" asChild>
              <a
                href="https://maps.google.com/?q=206+E+Redwood+St+Baltimore+MD+21202"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2"
              >
                <MapPin className="w-4 h-4" />
                Open in Maps
              </a>
            </Button>
          </div>

          {/* Back to site */}
          <div className="text-center">
            <Button variant="gold" size="lg" className="rounded-xl" asChild>
              <Link to="/" className="inline-flex items-center gap-2">
                Back to Proper Cuisine
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default OrderConfirmation;
