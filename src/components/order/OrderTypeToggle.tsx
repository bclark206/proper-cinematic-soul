import { MapPin, Truck } from "lucide-react";
import type { OrderType } from "@/hooks/useOrderType";

interface OrderTypeToggleProps {
  orderType: OrderType;
  onOrderTypeChange: (type: OrderType) => void;
}

// DELIVERY DISABLED — pickup only until DoorDash Drive is integrated
const OrderTypeToggle = ({ orderType, onOrderTypeChange }: OrderTypeToggleProps) => {
  // Force pickup mode
  if (orderType !== "pickup") {
    onOrderTypeChange("pickup");
  }

  return (
    <div className="flex justify-center py-4 sm:py-6" data-testid="order-type-toggle">
      <div className="inline-flex rounded-full bg-[#141414] border border-[#222222] p-1">
        <button
          className="inline-flex items-center gap-2 rounded-full px-5 py-2 sm:px-6 sm:py-2.5 text-sm font-medium bg-gold text-jet-black shadow-gold"
          aria-pressed={true}
          data-testid="toggle-pickup"
        >
          <MapPin className="w-4 h-4" />
          Pickup
        </button>
      </div>
    </div>
  );
};

export default OrderTypeToggle;
