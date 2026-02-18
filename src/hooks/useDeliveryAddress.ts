import { useState, useCallback } from "react";

export interface DeliveryAddress {
  street: string;
  apt: string;
  city: string;
  state: string;
  zip: string;
}

const STORAGE_KEY = "proper-cuisine-delivery-address";

const EMPTY_ADDRESS: DeliveryAddress = {
  street: "",
  apt: "",
  city: "",
  state: "",
  zip: "",
};

function loadAddress(): DeliveryAddress {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...EMPTY_ADDRESS, ...parsed };
    }
  } catch {
    // ignore
  }
  return EMPTY_ADDRESS;
}

export function useDeliveryAddress() {
  const [address, setAddressState] = useState<DeliveryAddress>(loadAddress);

  const setAddress = useCallback((addr: DeliveryAddress) => {
    setAddressState(addr);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(addr));
  }, []);

  const updateField = useCallback(
    (field: keyof DeliveryAddress, value: string) => {
      setAddressState((prev) => {
        const next = { ...prev, [field]: value };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    },
    []
  );

  return { address, setAddress, updateField };
}
