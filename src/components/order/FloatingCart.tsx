import { useEffect, useRef, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingCartProps {
  itemCount: number;
  onClick: () => void;
}

const FloatingCart = ({ itemCount, onClick }: FloatingCartProps) => {
  const prevCount = useRef(itemCount);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (itemCount > prevCount.current) {
      setPulsing(true);
      const timer = setTimeout(() => setPulsing(false), 600);
      return () => clearTimeout(timer);
    }
    prevCount.current = itemCount;
  }, [itemCount]);

  // Update ref after pulse starts so subsequent adds still trigger
  useEffect(() => {
    if (!pulsing) {
      prevCount.current = itemCount;
    }
  }, [pulsing, itemCount]);

  if (itemCount === 0) return null;

  return (
    <button
      onClick={onClick}
      className={cn(
        "fixed bottom-6 right-4 sm:bottom-6 sm:right-6 z-50 mb-safe",
        "w-14 h-14 sm:w-16 sm:h-16 rounded-2xl",
        "bg-gradient-to-br from-gold to-[hsl(43,35%,55%)]",
        "shadow-[0_4px_24px_rgba(197,168,106,0.35)]",
        "flex items-center justify-center",
        "hover:scale-105 active:scale-95 transition-all duration-300",
        "animate-in fade-in slide-in-from-bottom-4",
        pulsing && "cart-pulse"
      )}
    >
      <ShoppingBag className="w-6 h-6 text-jet-black" />
      <span className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-red-500 text-pure-white text-xs font-bold flex items-center justify-center shadow-lg ring-2 ring-[#0a0a0a]">
        {itemCount > 99 ? "99+" : itemCount}
      </span>
    </button>
  );
};

export default FloatingCart;
