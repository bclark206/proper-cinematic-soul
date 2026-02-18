import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import OrderCheckout from "../OrderCheckout";

// Mock useCart to return test cart data
const mockUpdateQuantity = vi.fn();
const mockClearCart = vi.fn();

vi.mock("@/hooks/useCart", () => ({
  DELIVERY_FEE: 500,
  useCart: () => ({
    items: [
      {
        cartItemId: "cart-1",
        itemId: "item-1",
        variationId: "var-1",
        name: "Jerk Chicken",
        basePrice: 1500,
        quantity: 2,
        modifiers: [
          {
            listId: "list-1",
            listName: "Sides",
            modifierId: "mod-1",
            modifierName: "Rice & Peas",
            price: 0,
          },
        ],
        specialInstructions: "",
        imageId: null,
      },
      {
        cartItemId: "cart-2",
        itemId: "item-2",
        variationId: "var-2",
        name: "Oxtail Stew",
        basePrice: 2200,
        quantity: 1,
        modifiers: [],
        specialInstructions: "",
        imageId: null,
      },
    ],
    isOpen: false,
    setIsOpen: vi.fn(),
    addItem: vi.fn(),
    removeItem: vi.fn(),
    updateQuantity: mockUpdateQuantity,
    clearCart: mockClearCart,
    itemCount: 3,
    subtotal: 5200,
    tax: 312,
    total: 5512,
    meetsMinimum: true,
  }),
}));

// Mock useOrderType — default to pickup
const mockSetOrderType = vi.fn();
let mockOrderType: "pickup" | "delivery" = "pickup";
vi.mock("@/hooks/useOrderType", () => ({
  useOrderType: () => ({
    orderType: mockOrderType,
    setOrderType: mockSetOrderType,
  }),
}));

// Mock useToast
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

const renderCheckout = () =>
  render(
    <BrowserRouter>
      <OrderCheckout />
    </BrowserRouter>
  );

describe("OrderCheckout - Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderType = "pickup";
  });

  it("renders the checkout heading", () => {
    renderCheckout();
    expect(screen.getByText("Checkout")).toBeInTheDocument();
  });

  it("renders back to menu link", () => {
    renderCheckout();
    const backLink = screen.getByText("Back to Menu");
    expect(backLink).toBeInTheDocument();
    expect(backLink.closest("a")).toHaveAttribute("href", "/order");
  });

  it("renders two-column layout with sidebar", () => {
    const { container } = renderCheckout();
    const sidebar = container.querySelector('[data-testid="order-summary-sidebar"]');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar?.className).toContain("lg:w-[380px]");
  });

  it("renders all form sections", () => {
    const { container } = renderCheckout();
    expect(container.querySelector('[data-testid="customer-info-section"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="pickup-time-section"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="tip-section"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="payment-section"]')).toBeInTheDocument();
  });
});

describe("OrderCheckout - Customer Info", () => {
  it("renders name, phone, and email inputs", () => {
    renderCheckout();
    expect(screen.getByLabelText("Full Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone Number")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("allows typing in form fields", () => {
    renderCheckout();
    const nameInput = screen.getByLabelText("Full Name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Jane Doe" } });
    expect(nameInput.value).toBe("Jane Doe");

    const phoneInput = screen.getByLabelText("Phone Number") as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "(443) 555-1234" } });
    expect(phoneInput.value).toBe("(443) 555-1234");

    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "jane@test.com" } });
    expect(emailInput.value).toBe("jane@test.com");
  });
});

describe("OrderCheckout - Pickup Time", () => {
  it("renders ASAP button", () => {
    renderCheckout();
    expect(screen.getByText("ASAP")).toBeInTheDocument();
  });

  it("ASAP is selected by default", () => {
    renderCheckout();
    const asapButton = screen.getByText("ASAP").closest("button");
    expect(asapButton?.className).toContain("border-gold");
  });
});

describe("OrderCheckout - Tip Section", () => {
  it("renders tip percentage options", () => {
    renderCheckout();
    expect(screen.getByText("15%")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("20% tip is selected by default", () => {
    renderCheckout();
    const tip20Button = screen.getByText("20%").closest("button");
    expect(tip20Button?.className).toContain("border-gold");
  });

  it("shows custom tip input when Custom is clicked", () => {
    renderCheckout();
    fireEvent.click(screen.getByText("Custom"));
    const customInput = screen.getByPlaceholderText("0.00");
    expect(customInput).toBeInTheDocument();
  });
});

describe("OrderCheckout - Payment Method Selection", () => {
  it("renders credit/debit card option", () => {
    renderCheckout();
    expect(screen.getByText("Credit / Debit Card")).toBeInTheDocument();
  });

  it("credit card is selected by default", () => {
    const { container } = renderCheckout();
    const cardButton = screen.getByText("Credit / Debit Card").closest("button");
    expect(cardButton?.className).toContain("border-gold");
    // Square card container should be visible
    const cardContainer = container.querySelector("#square-card-container");
    expect(cardContainer?.parentElement?.className).toContain("block");
  });

  it("renders payment method descriptions", () => {
    renderCheckout();
    expect(screen.getByText("Visa, Mastercard, Amex")).toBeInTheDocument();
  });

  it("renders secured by Square badge", () => {
    renderCheckout();
    expect(screen.getByText("Secured by Square")).toBeInTheDocument();
  });
});

describe("OrderCheckout - Order Summary Sidebar", () => {
  it("renders order summary heading", () => {
    renderCheckout();
    expect(screen.getByText("Order Summary")).toBeInTheDocument();
  });

  it("renders item count", () => {
    renderCheckout();
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("renders all cart items", () => {
    renderCheckout();
    expect(screen.getByText("Jerk Chicken")).toBeInTheDocument();
    expect(screen.getByText("Oxtail Stew")).toBeInTheDocument();
  });

  it("renders item modifiers", () => {
    renderCheckout();
    expect(screen.getByText("+ Rice & Peas")).toBeInTheDocument();
  });

  it("renders subtotal, tax, and total", () => {
    renderCheckout();
    expect(screen.getAllByText("Subtotal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Tax").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
  });

  it("renders quantity controls for items", () => {
    renderCheckout();
    const increaseButtons = screen.getAllByLabelText(/Increase quantity/);
    const decreaseButtons = screen.getAllByLabelText(/Decrease quantity/);
    expect(increaseButtons.length).toBe(2);
    expect(decreaseButtons.length).toBe(2);
  });

  it("calls updateQuantity when increase button is clicked", () => {
    renderCheckout();
    const increaseButtons = screen.getAllByLabelText(/Increase quantity/);
    fireEvent.click(increaseButtons[0]);
    expect(mockUpdateQuantity).toHaveBeenCalledWith("cart-1", 3);
  });

  it("calls updateQuantity when decrease button is clicked", () => {
    renderCheckout();
    const decreaseButtons = screen.getAllByLabelText(/Decrease quantity/);
    fireEvent.click(decreaseButtons[0]);
    expect(mockUpdateQuantity).toHaveBeenCalledWith("cart-1", 1);
  });

  it("renders add more items link", () => {
    renderCheckout();
    const addMoreLink = screen.getByText("Add more items");
    expect(addMoreLink).toBeInTheDocument();
    expect(addMoreLink.closest("a")).toHaveAttribute("href", "/order");
  });

  it("renders sticky sidebar on desktop", () => {
    const { container } = renderCheckout();
    const stickyContainer = container.querySelector('[data-testid="order-summary-sidebar"] .lg\\:sticky');
    expect(stickyContainer).toBeInTheDocument();
  });
});

describe("OrderCheckout - Place Order Button", () => {
  it("renders place order button with total in mobile sticky bar", () => {
    renderCheckout();
    const placeOrderButtons = screen.getAllByText("Place Order");
    expect(placeOrderButtons.length).toBeGreaterThan(0);
  });

  it("renders pickup address in footer", () => {
    renderCheckout();
    const addresses = screen.getAllByText("Pickup at 206 E Redwood St, Baltimore");
    expect(addresses.length).toBeGreaterThan(0);
  });
});

describe("OrderCheckout - Delivery Fee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not show delivery fee for pickup orders", () => {
    mockOrderType = "pickup";
    renderCheckout();
    expect(screen.queryByText("Delivery Fee")).not.toBeInTheDocument();
  });

  it("shows delivery fee for delivery orders", () => {
    mockOrderType = "delivery";
    renderCheckout();
    expect(screen.getByText("Delivery Fee")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });

  it("includes delivery fee in order total for delivery orders", () => {
    mockOrderType = "delivery";
    renderCheckout();
    // subtotal=5200, tax=312, tip=1040 (20% default), delivery=500 => total=7052 => $70.52
    const totalElements = screen.getAllByText("$70.52");
    expect(totalElements.length).toBeGreaterThan(0);
  });

  it("does not include delivery fee in order total for pickup orders", () => {
    mockOrderType = "pickup";
    renderCheckout();
    // subtotal=5200, tax=312, tip=1040 (20% default) => total=6552 => $65.52
    const totalElements = screen.getAllByText("$65.52");
    expect(totalElements.length).toBeGreaterThan(0);
  });
});
