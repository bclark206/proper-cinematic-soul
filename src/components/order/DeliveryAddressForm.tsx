import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin } from "lucide-react";
import type { DeliveryAddress } from "@/hooks/useDeliveryAddress";

interface DeliveryAddressFormProps {
  address: DeliveryAddress;
  onFieldChange: (field: keyof DeliveryAddress, value: string) => void;
}

const inputClassName =
  "bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/20 focus:border-gold/40 rounded-xl h-11";

const labelClassName = "text-cream/50 text-sm mb-1.5 block";

const DeliveryAddressForm = ({
  address,
  onFieldChange,
}: DeliveryAddressFormProps) => {
  return (
    <div
      className="max-w-xl mx-auto mt-2 mb-4 rounded-2xl bg-[#111111] border border-[#1e1e1e] p-4 sm:p-6"
      data-testid="delivery-address-form"
    >
      <div className="flex items-center gap-2 mb-3">
        <MapPin className="w-4 h-4 text-gold" />
        <h3 className="text-cream text-sm font-medium">Delivery Address</h3>
      </div>

      <p className="text-cream/40 text-xs mb-4" data-testid="delivery-radius-note">
        We deliver within 5 miles of 206 E Redwood St
      </p>

      <div className="space-y-3">
        <div>
          <Label htmlFor="delivery-street" className={labelClassName}>
            Street Address
          </Label>
          <Input
            id="delivery-street"
            data-testid="delivery-street"
            value={address.street}
            onChange={(e) => onFieldChange("street", e.target.value)}
            placeholder="123 Main St"
            className={inputClassName}
          />
        </div>

        <div>
          <Label htmlFor="delivery-apt" className={labelClassName}>
            Apt / Suite (optional)
          </Label>
          <Input
            id="delivery-apt"
            data-testid="delivery-apt"
            value={address.apt}
            onChange={(e) => onFieldChange("apt", e.target.value)}
            placeholder="Apt 4B"
            className={inputClassName}
          />
        </div>

        <div className="grid grid-cols-5 gap-3">
          <div className="col-span-2">
            <Label htmlFor="delivery-city" className={labelClassName}>
              City
            </Label>
            <Input
              id="delivery-city"
              data-testid="delivery-city"
              value={address.city}
              onChange={(e) => onFieldChange("city", e.target.value)}
              placeholder="City"
              className={inputClassName}
            />
          </div>
          <div className="col-span-1">
            <Label htmlFor="delivery-state" className={labelClassName}>
              State
            </Label>
            <Input
              id="delivery-state"
              data-testid="delivery-state"
              value={address.state}
              onChange={(e) => onFieldChange("state", e.target.value)}
              placeholder="FL"
              maxLength={2}
              className={inputClassName}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="delivery-zip" className={labelClassName}>
              ZIP Code
            </Label>
            <Input
              id="delivery-zip"
              data-testid="delivery-zip"
              value={address.zip}
              onChange={(e) => onFieldChange("zip", e.target.value)}
              placeholder="33101"
              maxLength={10}
              inputMode="numeric"
              className={inputClassName}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeliveryAddressForm;
