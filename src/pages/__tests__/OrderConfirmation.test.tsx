import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import OrderConfirmation from "../OrderConfirmation";

vi.mock("@/hooks/useCart", () => ({
  ESTIMATED_DELIVERY_TIME: "45-60 minutes",
}));

const pickupOrderData = {
  confirmationNumber: "PC-1234",
  items: [
    {
      name: "Jerk Chicken",
      quantity: 2,
      basePrice: 1500,
      modifiers: [{ modifierName: "Rice & Peas", price: 0 }],
    },
  ],
  subtotal: 3000,
  tax: 180,
  tip: 600,
  total: 3780,
  customer: { name: "Jane Doe", phone: "4435551234", email: "jane@test.com" },
  pickupTime: "ASAP (20–30 min)",
  orderType: "PICKUP",
  createdAt: new Date().toISOString(),
};

const deliveryOrderData = {
  ...pickupOrderData,
  orderType: "DELIVERY",
  deliveryFee: 500,
  total: 4280,
  deliveryAddress: {
    street: "123 Main St",
    apt: "4B",
    city: "Baltimore",
    state: "MD",
    zip: "21201",
  },
  deliveryNotes: "Gate code: 5678",
};

const renderConfirmation = (orderData: object | null = pickupOrderData) => {
  if (orderData) {
    sessionStorage.setItem(
      "proper-order-confirmation",
      JSON.stringify(orderData)
    );
  } else {
    sessionStorage.removeItem("proper-order-confirmation");
  }

  return render(
    <BrowserRouter>
      <OrderConfirmation />
    </BrowserRouter>
  );
};

describe("OrderConfirmation - Pickup Order", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows pickup time for pickup orders", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.getByText("Pickup Time")).toBeInTheDocument();
    expect(screen.getByText("ASAP (20–30 min)")).toBeInTheDocument();
  });

  it("shows pickup location for pickup orders", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.getByText("Pickup Location")).toBeInTheDocument();
    const infoSection = screen.getByTestId("order-info-section");
    expect(infoSection).toHaveTextContent("206 E Redwood St");
  });

  it("shows map link for pickup orders", () => {
    renderConfirmation(pickupOrderData);
    expect(
      screen.getByText("Get directions to Proper Cuisine")
    ).toBeInTheDocument();
    expect(screen.getByText("Open in Maps")).toBeInTheDocument();
  });

  it("does not show delivery address for pickup orders", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.queryByText("Delivery Address")).not.toBeInTheDocument();
    expect(screen.queryByTestId("delivery-address")).not.toBeInTheDocument();
  });

  it("does not show estimated delivery time for pickup orders", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.queryByText("Est. Delivery Time")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("estimated-delivery-time")
    ).not.toBeInTheDocument();
  });
});

describe("OrderConfirmation - Delivery Order", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows estimated delivery time for delivery orders", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.getByText("Est. Delivery Time")).toBeInTheDocument();
    expect(screen.getByTestId("estimated-delivery-time")).toHaveTextContent(
      "45-60 minutes"
    );
  });

  it("shows delivery address for delivery orders", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.getByText("Delivery Address")).toBeInTheDocument();
    const addressEl = screen.getByTestId("delivery-address");
    expect(addressEl).toHaveTextContent("123 Main St");
    expect(addressEl).toHaveTextContent("4B");
  });

  it("shows city, state, and zip for delivery orders", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.getByText("Baltimore, MD 21201")).toBeInTheDocument();
  });

  it("shows delivery notes when present", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.getByText("Delivery Notes")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-notes")).toHaveTextContent(
      "Gate code: 5678"
    );
  });

  it("does not show delivery notes section when notes are absent", () => {
    const { deliveryNotes: _, ...noNotes } = deliveryOrderData;
    renderConfirmation(noNotes);
    expect(
      screen.queryByTestId("delivery-notes-section")
    ).not.toBeInTheDocument();
  });

  it("does not show pickup location for delivery orders", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.queryByText("Pickup Location")).not.toBeInTheDocument();
    expect(screen.queryByText("Pickup Time")).not.toBeInTheDocument();
  });

  it("does not show map link for delivery orders", () => {
    renderConfirmation(deliveryOrderData);
    expect(
      screen.queryByText("Get directions to Proper Cuisine")
    ).not.toBeInTheDocument();
  });

  it("shows delivery fee in order summary", () => {
    renderConfirmation(deliveryOrderData);
    expect(screen.getByText("Delivery Fee")).toBeInTheDocument();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
  });

  it("shows delivery address without apt when apt is empty", () => {
    const noApt = {
      ...deliveryOrderData,
      deliveryAddress: { ...deliveryOrderData.deliveryAddress, apt: "" },
    };
    renderConfirmation(noApt);
    const addressEl = screen.getByTestId("delivery-address");
    expect(addressEl).toHaveTextContent("123 Main St");
    expect(addressEl.textContent).not.toContain(",");
  });
});

describe("OrderConfirmation - Celebratory Header", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows celebratory kitchen status message", () => {
    renderConfirmation(pickupOrderData);
    expect(
      screen.getByText("Your order is on its way to the kitchen!")
    ).toBeInTheDocument();
  });

  it("shows thank you message", () => {
    renderConfirmation(pickupOrderData);
    expect(
      screen.getByText("Thank you for choosing Proper Cuisine")
    ).toBeInTheDocument();
  });

  it("shows sparkle and party icons for celebratory feel", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.getByTestId("sparkle-icon")).toBeInTheDocument();
    expect(screen.getByTestId("party-icon")).toBeInTheDocument();
  });

  it("shows Order Confirmed heading", () => {
    renderConfirmation(pickupOrderData);
    expect(screen.getByText("Confirmed!")).toBeInTheDocument();
  });

  it("renders kitchen status badge with chef hat", () => {
    renderConfirmation(pickupOrderData);
    const badge = screen.getByTestId("kitchen-status");
    expect(badge).toHaveTextContent(
      "Your order is on its way to the kitchen!"
    );
  });
});

describe("OrderConfirmation - No Order", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("shows no order found when sessionStorage is empty", () => {
    renderConfirmation(null);
    expect(screen.getByText("No Order Found")).toBeInTheDocument();
  });
});
