import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Navigation from "@/components/Navigation";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPrice } from "@/data/menu";
import {
  CheckCircle,
  Clock,
  MapPin,
  Phone,
  ChefHat,
  ArrowRight,
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
  tip: number;
  total: number;
  customer: { name: string; phone: string; email: string };
  pickupTime: string;
  createdAt: string;
}

const OrderConfirmation = () => {
  const [order, setOrder] = useState<OrderData | null>(null);

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

  if (!order) {
    return (
      <div className="min-h-screen bg-jet-black">
        <Navigation />
        <div className="flex flex-col items-center justify-center min-h-[80vh] px-4">
          <h1 className="font-display text-3xl text-pure-white mb-4">
            No Order Found
          </h1>
          <p className="text-cream/50 mb-8">
            It looks like you haven't placed an order yet.
          </p>
          <Button variant="gold" size="lg" asChild>
            <Link to="/order">Browse Menu</Link>
          </Button>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-jet-black">
      <Navigation />

      <main className="pt-28 pb-16 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          {/* Success Header */}
          <div className="text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gold/10 mb-6 fade-in-up">
              <CheckCircle className="w-10 h-10 text-gold" />
            </div>
            <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold text-pure-white mb-4 fade-in-up">
              Order <span className="text-gold">Confirmed!</span>
            </h1>
            <div className="w-24 h-1 bg-gradient-to-r from-gold to-[hsl(43,35%,68%)] rounded-full mx-auto mb-6"></div>
            <div className="inline-flex items-center gap-2 bg-gold/10 text-gold px-4 py-2 rounded-full fade-in-slow">
              <ChefHat className="w-5 h-5" />
              <span className="font-medium">Your order has been sent to the kitchen!</span>
            </div>
          </div>

          {/* Order Number */}
          <Card className="bg-[#1a1a1a] border-gold/10 mb-6">
            <CardContent className="p-6 text-center">
              <p className="text-cream/40 text-sm mb-1">Order Number</p>
              <p className="font-display text-3xl font-bold text-gold tracking-wider">
                {order.confirmationNumber}
              </p>
            </CardContent>
          </Card>

          {/* Pickup Info */}
          <Card className="bg-[#1a1a1a] border-gold/10 mb-6">
            <CardContent className="p-6">
              <div className="grid sm:grid-cols-3 gap-6">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-lg bg-gold/10">
                    <Clock className="w-5 h-5 text-gold" />
                  </div>
                  <div>
                    <p className="text-cream/40 text-xs">Pickup Time</p>
                    <p className="text-cream font-medium">{order.pickupTime}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-lg bg-gold/10">
                    <MapPin className="w-5 h-5 text-gold" />
                  </div>
                  <div>
                    <p className="text-cream/40 text-xs">Pickup Location</p>
                    <p className="text-cream font-medium text-sm">206 E Redwood St</p>
                    <p className="text-cream/50 text-xs">Baltimore, MD 21202</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-lg bg-gold/10">
                    <Phone className="w-5 h-5 text-gold" />
                  </div>
                  <div>
                    <p className="text-cream/40 text-xs">Questions?</p>
                    <p className="text-cream font-medium">(443) 432-2771</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Order Summary */}
          <Card className="bg-[#1a1a1a] border-gold/10 mb-6">
            <CardContent className="p-6">
              <h2 className="font-display text-xl text-pure-white mb-4">
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
                      className="flex justify-between gap-3 pb-3 border-b border-gold/5"
                    >
                      <div>
                        <p className="text-cream text-sm">
                          {item.quantity}x {item.name}
                        </p>
                        {item.modifiers.map((m, mi) => (
                          <p key={mi} className="text-cream/30 text-xs">
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

              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-cream/50">
                  <span>Subtotal</span>
                  <span>{formatPrice(order.subtotal)}</span>
                </div>
                <div className="flex justify-between text-cream/50">
                  <span>Tax</span>
                  <span>{formatPrice(order.tax)}</span>
                </div>
                <div className="flex justify-between text-cream/50">
                  <span>Tip</span>
                  <span>{formatPrice(order.tip)}</span>
                </div>
                <div className="flex justify-between font-semibold text-base border-t border-gold/10 pt-3">
                  <span className="text-pure-white">Total</span>
                  <span className="text-gold">{formatPrice(order.total)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Map Link */}
          <Card className="bg-[#1a1a1a] border-gold/10 mb-8">
            <CardContent className="p-6 text-center">
              <p className="text-cream/50 text-sm mb-3">
                Get directions to Proper Cuisine
              </p>
              <Button variant="outline-gold" asChild>
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
            </CardContent>
          </Card>

          {/* Back to site */}
          <div className="text-center">
            <Button variant="gold" size="lg" asChild>
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
