import { MapPin, Truck } from "lucide-react";
import type { OrderType } from "@/hooks/useOrderType";

interface OrderTypeToggleProps {
  orderType: OrderType;
  onOrderTypeChange: (type: OrderType) => void;
}

const OrderTypeToggle = ({ orderType, onOrderTypeChange }: OrderTypeToggleProps) => {
  return (
    <div className="flex justify-center py-4 sm:py-6" data-testid="order-type-toggle">
      <div className="inline-flex rounded-full bg-[#141414] border border-[#222222] p-1">
        <button
          onClick={() => onOrderTypeChange("pickup")}
          className={`
            inline-flex items-center gap-2 rounded-full px-5 py-2 sm:px-6 sm:py-2.5 text-sm font-medium
            transition-all duration-200
            ${
              orderType === "pickup"
                ? "bg-gold text-jet-black shadow-gold"
                : "text-cream/50 hover:text-cream/80"
            }
          `}
          aria-pressed={orderType === "pickup"}
          data-testid="toggle-pickup"
        >
          <MapPin className="w-4 h-4" />
          Pickup
        </button>
        <button
          onClick={() => onOrderTypeChange("delivery")}
          className={`
            inline-flex items-center gap-2 rounded-full px-5 py-2 sm:px-6 sm:py-2.5 text-sm font-medium
            transition-all duration-200
            ${
              orderType === "delivery"
                ? "bg-gold text-jet-black shadow-gold"
                : "text-cream/50 hover:text-cream/80"
            }
          `}
          aria-pressed={orderType === "delivery"}
          data-testid="toggle-delivery"
        >
          <Truck className="w-4 h-4" />
          Delivery
        </button>
      </div>
    </div>
  );
};

export default OrderTypeToggle;
