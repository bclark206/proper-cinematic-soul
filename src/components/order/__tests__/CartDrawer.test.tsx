import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CartDrawer from "../CartDrawer";
import type { CartHook } from "@/hooks/useCart";
import type { CartItem } from "@/hooks/useCart";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

function makeCart(overrides: Partial<CartHook> = {}): CartHook {
  return {
    items: [],
    isOpen: true,
    setIsOpen: vi.fn(),
    addItem: vi.fn(),
    removeItem: vi.fn(),
    updateQuantity: vi.fn(),
    clearCart: vi.fn(),
    itemCount: 0,
    subtotal: 0,
    tax: 0,
    total: 0,
    meetsMinimum: false,
    ...overrides,
  };
}

const sampleItem: CartItem = {
  cartItemId: "cart-1",
  itemId: "item-1",
  variationId: "var-1",
  name: "Grilled Salmon",
  basePrice: 3000,
  quantity: 1,
  modifiers: [],
  specialInstructions: "",
  imageId: "img-123",
};

const itemWithModifiers: CartItem = {
  ...sampleItem,
  cartItemId: "cart-2",
  name: "Power Bowl",
  modifiers: [
    {
      listId: "list-1",
      listName: "Choose Two Sides",
      modifierId: "mod-1",
      modifierName: "Fries",
      price: 0,
    },
    {
      listId: "list-1",
      listName: "Choose Two Sides",
      modifierId: "mod-2",
      modifierName: "Mac & Cheese",
      price: 500,
    },
  ],
  specialInstructions: "No onions please",
};

const getItemImageUrl = vi.fn((imageId: string | null) =>
  imageId === "img-123" ? "https://example.com/salmon.jpg" : null
);

function renderDrawer(cart: CartHook, orderType: "pickup" | "delivery" = "pickup") {
  return render(
    <MemoryRouter>
      <CartDrawer cart={cart} getItemImageUrl={getItemImageUrl} orderType={orderType} />
    </MemoryRouter>
  );
}

describe("CartDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when cart has no items", () => {
    renderDrawer(makeCart());
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    expect(
      screen.getByText(/Explore our menu/)
    ).toBeInTheDocument();
  });

  it("renders Browse Menu CTA button in empty state", () => {
    renderDrawer(makeCart());
    expect(screen.getByText("Browse Menu")).toBeInTheDocument();
  });

  it("closes drawer and navigates to menu when Browse Menu is clicked", () => {
    const setIsOpen = vi.fn();
    renderDrawer(makeCart({ setIsOpen }));
    fireEvent.click(screen.getByText("Browse Menu"));
    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith("/order");
  });

  it("renders item name", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    expect(screen.getByText("Grilled Salmon")).toBeInTheDocument();
  });

  it("renders item image when imageId is available", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    const img = screen.getByAltText("Grilled Salmon");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/salmon.jpg");
  });

  it("renders placeholder when item has no image", () => {
    const noImageItem = { ...sampleItem, imageId: null };
    const cart = makeCart({
      items: [noImageItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    expect(screen.queryByAltText("Grilled Salmon")).not.toBeInTheDocument();
  });

  it("renders modifier chips for item with modifiers", () => {
    const cart = makeCart({
      items: [itemWithModifiers],
      itemCount: 1,
      subtotal: 3500,
      tax: 210,
      total: 3710,
    });
    renderDrawer(cart);
    expect(screen.getByText("Fries")).toBeInTheDocument();
    expect(screen.getByText(/Mac & Cheese/)).toBeInTheDocument();
  });

  it("renders special instructions", () => {
    const cart = makeCart({
      items: [itemWithModifiers],
      itemCount: 1,
      subtotal: 3500,
      tax: 210,
      total: 3710,
    });
    renderDrawer(cart);
    expect(screen.getByText(/No onions please/)).toBeInTheDocument();
  });

  it("displays item count in header", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    expect(screen.getByText(/1 item in cart/)).toBeInTheDocument();
  });

  it("uses plural form for multiple items", () => {
    const cart = makeCart({
      items: [sampleItem, { ...sampleItem, cartItemId: "cart-3" }],
      itemCount: 2,
      subtotal: 6000,
      tax: 360,
      total: 6360,
    });
    renderDrawer(cart);
    expect(screen.getByText(/2 items in cart/)).toBeInTheDocument();
  });

  it("renders subtotal, tax, and total labels", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    expect(screen.getByText("Subtotal")).toBeInTheDocument();
    expect(screen.getByText("Tax (6%)")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("shows minimum order message when below threshold", () => {
    const cart = makeCart({
      items: [{ ...sampleItem, basePrice: 1000 }],
      itemCount: 1,
      subtotal: 1000,
      tax: 60,
      total: 1060,
      meetsMinimum: false,
    });
    renderDrawer(cart);
    expect(screen.getByText("Minimum order: $15.00")).toBeInTheDocument();
  });

  it("disables checkout button when minimum not met", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 1000,
      tax: 60,
      total: 1060,
      meetsMinimum: false,
    });
    renderDrawer(cart);
    expect(screen.getByText("Proceed to Checkout")).toBeDisabled();
  });

  it("enables checkout button when minimum is met", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
      meetsMinimum: true,
    });
    renderDrawer(cart);
    expect(screen.getByText("Proceed to Checkout")).toBeEnabled();
  });

  it("navigates to checkout and closes drawer on checkout click", () => {
    const setIsOpen = vi.fn();
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
      meetsMinimum: true,
      setIsOpen,
    });
    renderDrawer(cart);
    fireEvent.click(screen.getByText("Proceed to Checkout"));
    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(mockNavigate).toHaveBeenCalledWith("/order/checkout");
  });

  it("calls removeItem when delete button is clicked", () => {
    const removeItem = vi.fn();
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
      removeItem,
    });
    renderDrawer(cart);
    fireEvent.click(screen.getByLabelText("Remove Grilled Salmon"));
    expect(removeItem).toHaveBeenCalledWith("cart-1");
  });

  it("calls updateQuantity when increment button is clicked", () => {
    const updateQuantity = vi.fn();
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
      updateQuantity,
    });
    renderDrawer(cart);
    fireEvent.click(screen.getByLabelText("Increase quantity"));
    expect(updateQuantity).toHaveBeenCalledWith("cart-1", 2);
  });

  it("calls updateQuantity when decrement button is clicked", () => {
    const updateQuantity = vi.fn();
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
      updateQuantity,
    });
    renderDrawer(cart);
    fireEvent.click(screen.getByLabelText("Decrease quantity"));
    expect(updateQuantity).toHaveBeenCalledWith("cart-1", 0);
  });

  it("shows secure checkout badge", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    expect(screen.getByText("Secure pickup order")).toBeInTheDocument();
  });

  it("renders item thumbnails with rounded-xl corners", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart);
    const img = screen.getByAltText("Grilled Salmon");
    const wrapper = img.parentElement;
    expect(wrapper?.className).toContain("rounded-xl");
  });

  it("does not render footer when cart is empty", () => {
    renderDrawer(makeCart());
    expect(screen.queryByText("Subtotal")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Proceed to Checkout")
    ).not.toBeInTheDocument();
  });

  it("does not show delivery fee for pickup orders", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart, "pickup");
    expect(screen.queryByText("Delivery Fee")).not.toBeInTheDocument();
  });

  it("shows delivery fee for delivery orders", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart, "delivery");
    expect(screen.getByText("Delivery Fee")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });

  it("includes delivery fee in displayed total for delivery orders", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart, "delivery");
    // total should be $31.80 + $5.00 = $36.80
    expect(screen.getByText("$36.80")).toBeInTheDocument();
  });

  it("shows estimated delivery time for delivery orders", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart, "delivery");
    expect(screen.getByText("Est. Delivery")).toBeInTheDocument();
    expect(screen.getByText("45-60 minutes")).toBeInTheDocument();
  });

  it("does not show estimated delivery time for pickup orders", () => {
    const cart = makeCart({
      items: [sampleItem],
      itemCount: 1,
      subtotal: 3000,
      tax: 180,
      total: 3180,
    });
    renderDrawer(cart, "pickup");
    expect(screen.queryByText("Est. Delivery")).not.toBeInTheDocument();
    expect(screen.queryByText("45-60 minutes")).not.toBeInTheDocument();
  });
});
