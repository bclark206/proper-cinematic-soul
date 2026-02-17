import { ShoppingBag } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingCartProps {
  itemCount: number;
  onClick: () => void;
}

const FloatingCart = ({ itemCount, onClick }: FloatingCartProps) => {
  if (itemCount === 0) return null;

  return (
    <button
      onClick={onClick}
      className={cn(
        "fixed bottom-6 right-6 z-50",
        "w-16 h-16 rounded-2xl",
        "bg-gradient-to-br from-gold to-[hsl(43,35%,55%)]",
        "shadow-[0_4px_24px_rgba(197,168,106,0.35)]",
        "flex items-center justify-center",
        "hover:scale-105 active:scale-95 transition-all duration-300",
        "animate-in fade-in slide-in-from-bottom-4"
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
