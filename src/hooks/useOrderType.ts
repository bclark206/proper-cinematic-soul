import { useState, useCallback } from "react";

export type OrderType = "pickup" | "delivery";

const STORAGE_KEY = "proper-cuisine-order-type";

function loadOrderType(): OrderType {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "pickup" || stored === "delivery") return stored;
  } catch {
    // ignore
  }
  return "pickup";
}

export function useOrderType() {
  const [orderType, setOrderTypeState] = useState<OrderType>(loadOrderType);

  const setOrderType = useCallback((type: OrderType) => {
    setOrderTypeState(type);
    localStorage.setItem(STORAGE_KEY, type);
  }, []);

  return { orderType, setOrderType };
}
