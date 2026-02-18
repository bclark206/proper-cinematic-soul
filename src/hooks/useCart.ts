import { useState, useCallback, useMemo } from "react";

export interface SelectedModifier {
  listId: string;
  listName: string;
  modifierId: string;
  modifierName: string;
  price: number; // cents
}

export interface CartItem {
  cartItemId: string;
  itemId: string;
  variationId: string;
  name: string;
  basePrice: number; // cents
  quantity: number;
  modifiers: SelectedModifier[];
  specialInstructions: string;
  imageId: string | null;
}

const CART_STORAGE_KEY = "proper-cuisine-cart";

function loadCart(): CartItem[] {
  try {
    const data = localStorage.getItem(CART_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveCart(items: CartItem[]) {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
}

let cartIdCounter = Date.now();

export function useCart() {
  const [items, setItems] = useState<CartItem[]>(loadCart);
  const [isOpen, setIsOpen] = useState(false);

  const updateAndSave = useCallback((updater: (prev: CartItem[]) => CartItem[]) => {
    setItems((prev) => {
      const next = updater(prev);
      saveCart(next);
      return next;
    });
  }, []);

  const addItem = useCallback(
    (item: Omit<CartItem, "cartItemId">) => {
      updateAndSave((prev) => [
        ...prev,
        { ...item, cartItemId: `cart-${++cartIdCounter}` },
      ]);
      setIsOpen(true);
    },
    [updateAndSave]
  );

  const removeItem = useCallback(
    (cartItemId: string) => {
      updateAndSave((prev) => prev.filter((i) => i.cartItemId !== cartItemId));
    },
    [updateAndSave]
  );

  const updateQuantity = useCallback(
    (cartItemId: string, quantity: number) => {
      if (quantity <= 0) {
        removeItem(cartItemId);
        return;
      }
      updateAndSave((prev) =>
        prev.map((i) => (i.cartItemId === cartItemId ? { ...i, quantity } : i))
      );
    },
    [updateAndSave, removeItem]
  );

  const clearCart = useCallback(() => {
    updateAndSave(() => []);
  }, [updateAndSave]);

  const itemCount = useMemo(
    () => items.reduce((sum, i) => sum + i.quantity, 0),
    [items]
  );

  const subtotal = useMemo(
    () =>
      items.reduce((sum, i) => {
        const modTotal = i.modifiers.reduce((ms, m) => ms + m.price, 0);
        return sum + (i.basePrice + modTotal) * i.quantity;
      }, 0),
    [items]
  );

  const tax = useMemo(() => Math.round(subtotal * 0.06), [subtotal]);
  const total = useMemo(() => subtotal + tax, [subtotal, tax]);

  const meetsMinimum = subtotal >= 1500; // $15 minimum

  return {
    items,
    isOpen,
    setIsOpen,
    addItem,
    removeItem,
    updateQuantity,
    clearCart,
    itemCount,
    subtotal,
    tax,
    total,
    meetsMinimum,
  };
}

export type CartHook = ReturnType<typeof useCart>;
