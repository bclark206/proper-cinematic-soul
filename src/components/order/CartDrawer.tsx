import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Minus, Plus, Trash2, ShoppingBag } from "lucide-react";
import { formatPrice } from "@/data/menu";
import type { CartHook } from "@/hooks/useCart";
import { useNavigate } from "react-router-dom";

interface CartDrawerProps {
  cart: CartHook;
}

const CartDrawer = ({ cart }: CartDrawerProps) => {
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
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-gold/8">
          <SheetTitle className="font-display text-xl text-pure-white flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gold/10 flex items-center justify-center">
              <ShoppingBag className="w-4.5 h-4.5 text-gold" />
            </div>
            Your Order
          </SheetTitle>
          <SheetDescription className="text-cream/40 text-sm">
            {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"}
          </SheetDescription>
        </SheetHeader>

        {/* Cart Items */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          {cart.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-6">
              <div className="w-20 h-20 rounded-2xl bg-gold/5 flex items-center justify-center mb-5">
                <ShoppingBag className="w-9 h-9 text-gold/20" />
              </div>
              <p className="text-cream/40 font-display text-lg">
                Your cart is empty
              </p>
              <p className="text-cream/25 text-sm mt-1">
                Add some delicious items from our menu
              </p>
            </div>
          ) : (
            cart.items.map((item) => {
              const modTotal = item.modifiers.reduce(
                (s, m) => s + m.price,
                0
              );
              const lineTotal = (item.basePrice + modTotal) * item.quantity;

              return (
                <div
                  key={item.cartItemId}
                  className="bg-[#161616] rounded-xl p-4 border border-[#222222]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-display text-sm font-semibold text-pure-white leading-tight">
                        {item.name}
                      </h4>
                      {item.modifiers.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {item.modifiers.map((mod) => (
                            <p
                              key={mod.modifierId}
                              className="text-xs text-cream/30"
                            >
                              + {mod.modifierName}
                              {mod.price > 0 && ` (${formatPrice(mod.price)})`}
                            </p>
                          ))}
                        </div>
                      )}
                      {item.specialInstructions && (
                        <p className="text-xs text-gold/30 mt-1 italic">
                          &ldquo;{item.specialInstructions}&rdquo;
                        </p>
                      )}
                    </div>
                    <span className="text-gold font-semibold text-sm whitespace-nowrap">
                      {formatPrice(lineTotal)}
                    </span>
                  </div>

                  {/* Quantity controls */}
                  <div className="flex items-center justify-between mt-3">
                    <div className="flex items-center border border-[#2a2a2a] rounded-lg overflow-hidden bg-[#111111]">
                      <button
                        onClick={() =>
                          cart.updateQuantity(
                            item.cartItemId,
                            item.quantity - 1
                          )
                        }
                        className="px-2.5 py-1.5 text-cream/50 hover:text-gold hover:bg-gold/10 transition-colors"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-3 py-1.5 text-pure-white text-sm font-medium">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() =>
                          cart.updateQuantity(
                            item.cartItemId,
                            item.quantity + 1
                          )
                        }
                        className="px-2.5 py-1.5 text-cream/50 hover:text-gold hover:bg-gold/10 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <button
                      onClick={() => cart.removeItem(item.cartItemId)}
                      className="text-cream/20 hover:text-red-400 transition-colors p-1.5 rounded-lg hover:bg-red-400/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer with totals */}
        {cart.items.length > 0 && (
          <div className="border-t border-gold/8 px-6 py-5 space-y-3 bg-[#0a0a0a]">
            <div className="flex items-center justify-between text-sm">
              <span className="text-cream/40">Subtotal</span>
              <span className="text-cream/70">{formatPrice(cart.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-cream/40">Tax (6%)</span>
              <span className="text-cream/70">{formatPrice(cart.tax)}</span>
            </div>
            <div className="flex items-center justify-between text-base font-semibold border-t border-gold/8 pt-3">
              <span className="text-pure-white">Total</span>
              <span className="text-gold font-display">{formatPrice(cart.total)}</span>
            </div>

            {!cart.meetsMinimum && (
              <p className="text-xs text-amber-400/60 text-center py-1">
                Minimum order: $15.00
              </p>
            )}

            <Button
              variant="gold"
              size="lg"
              className="w-full text-base font-semibold rounded-xl h-12"
              disabled={!cart.meetsMinimum}
              onClick={handleCheckout}
            >
              Proceed to Checkout
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};

export default CartDrawer;
