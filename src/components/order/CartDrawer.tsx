import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Minus,
  Plus,
  Trash2,
  ShoppingBag,
  UtensilsCrossed,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { formatPrice } from "@/data/menu";
import type { CartHook } from "@/hooks/useCart";
import { useNavigate } from "react-router-dom";

interface CartDrawerProps {
  cart: CartHook;
  getItemImageUrl: (imageId: string | null) => string | null;
}

const CartDrawer = ({ cart, getItemImageUrl }: CartDrawerProps) => {
  const navigate = useNavigate();

  const handleCheckout = () => {
    cart.setIsOpen(false);
    navigate("/order/checkout");
  };

  return (
    <Sheet open={cart.isOpen} onOpenChange={cart.setIsOpen}>
      <SheetContent
        side="right"
        className="bg-[#0d0d0d] border-l border-gold/10 text-pure-white w-full max-w-full sm:max-w-md flex flex-col p-0"
      >
        {/* Header */}
        <SheetHeader className="px-6 pt-6 pb-5 border-b border-gold/8">
          <SheetTitle className="font-display text-xl text-pure-white flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold/15 to-gold/5 flex items-center justify-center">
              <ShoppingBag className="w-[18px] h-[18px] text-gold" />
            </div>
            <div>
              Your Order
              <SheetDescription className="text-cream/40 text-sm font-body font-normal mt-0.5">
                {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"} in
                cart
              </SheetDescription>
            </div>
          </SheetTitle>
        </SheetHeader>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto scroll-touch px-4 sm:px-5 py-4 sm:py-5 space-y-3 sm:space-y-4">
          {cart.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-gold/8 to-gold/3 flex items-center justify-center mb-6">
                <ShoppingBag className="w-10 h-10 text-gold/20" />
              </div>
              <p className="text-cream/50 font-display text-lg mb-2">
                Your cart is empty
              </p>
              <p className="text-cream/25 text-sm leading-relaxed max-w-[200px]">
                Add some delicious items from our menu to get started
              </p>
            </div>
          ) : (
            cart.items.map((item) => {
              const modTotal = item.modifiers.reduce(
                (s, m) => s + m.price,
                0
              );
              const lineTotal = (item.basePrice + modTotal) * item.quantity;
              const imageUrl = getItemImageUrl(item.imageId);

              return (
                <div
                  key={item.cartItemId}
                  className="bg-[#141414] rounded-2xl border border-[#1e1e1e] overflow-hidden transition-colors hover:border-[#282828]"
                >
                  <div className="flex gap-4 p-4">
                    {/* Item Thumbnail */}
                    <div className="w-20 h-20 rounded-xl overflow-hidden flex-shrink-0 bg-[#1a1a1a]">
                      {imageUrl ? (
                        <img
                          src={imageUrl}
                          alt={item.name}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1e1a14] to-[#141210]">
                          <UtensilsCrossed className="w-6 h-6 text-gold/15" />
                        </div>
                      )}
                    </div>

                    {/* Item Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-display text-[0.9rem] font-semibold text-pure-white leading-tight">
                          {item.name}
                        </h4>
                        <button
                          onClick={() => cart.removeItem(item.cartItemId)}
                          className="text-cream/15 hover:text-red-400 transition-colors p-1 rounded-lg hover:bg-red-400/10 -mt-0.5 -mr-1 flex-shrink-0"
                          aria-label={`Remove ${item.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {item.modifiers.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {item.modifiers.map((mod) => (
                            <span
                              key={mod.modifierId}
                              className="inline-block text-[0.7rem] text-cream/40 bg-white/[0.04] px-2 py-0.5 rounded-full"
                            >
                              {mod.modifierName}
                              {mod.price > 0 && ` +${formatPrice(mod.price)}`}
                            </span>
                          ))}
                        </div>
                      )}

                      {item.specialInstructions && (
                        <p className="text-[0.7rem] text-gold/30 mt-1.5 italic leading-snug truncate">
                          &ldquo;{item.specialInstructions}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Bottom bar: Quantity + Price */}
                  <div className="flex items-center justify-between px-4 py-3 bg-[#111111] border-t border-[#1a1a1a]">
                    <div className="flex items-center border border-[#252525] rounded-full overflow-hidden bg-[#0d0d0d]">
                      <button
                        onClick={() =>
                          cart.updateQuantity(
                            item.cartItemId,
                            item.quantity - 1
                          )
                        }
                        className="px-2.5 py-1.5 text-cream/40 hover:text-gold hover:bg-gold/10 active:bg-gold/20 transition-colors"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="px-3 py-1.5 text-pure-white text-xs font-semibold tabular-nums min-w-[2rem] text-center">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() =>
                          cart.updateQuantity(
                            item.cartItemId,
                            item.quantity + 1
                          )
                        }
                        className="px-2.5 py-1.5 text-cream/40 hover:text-gold hover:bg-gold/10 active:bg-gold/20 transition-colors"
                        aria-label="Increase quantity"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    <span className="text-gold font-display font-semibold text-sm">
                      {formatPrice(lineTotal)}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer with totals */}
        {cart.items.length > 0 && (
          <div className="border-t border-gold/8 bg-[#0a0a0a]">
            {/* Order Summary */}
            <div className="px-6 pt-5 pb-4 space-y-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-cream/40">Subtotal</span>
                <span className="text-cream/70 tabular-nums">
                  {formatPrice(cart.subtotal)}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-cream/40">Tax (6%)</span>
                <span className="text-cream/70 tabular-nums">
                  {formatPrice(cart.tax)}
                </span>
              </div>
              <div className="flex items-center justify-between pt-3 border-t border-gold/8">
                <span className="text-pure-white font-semibold">Total</span>
                <span className="text-gold font-display font-bold text-lg tabular-nums">
                  {formatPrice(cart.total)}
                </span>
              </div>
            </div>

            {/* Checkout Actions */}
            <div className="px-6 pb-6 pb-safe space-y-3">
              {!cart.meetsMinimum && (
                <p className="text-xs text-amber-400/60 text-center py-1">
                  Minimum order: $15.00
                </p>
              )}

              <Button
                variant="gold"
                size="lg"
                className="w-full text-base font-semibold rounded-xl h-13 gap-2"
                disabled={!cart.meetsMinimum}
                onClick={handleCheckout}
              >
                Proceed to Checkout
                <ArrowRight className="w-4 h-4" />
              </Button>

              <div className="flex items-center justify-center gap-1.5 pt-1">
                <ShieldCheck className="w-3 h-3 text-cream/20" />
                <span className="text-[0.65rem] text-cream/20">
                  Secure pickup order
                </span>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default CartDrawer;
