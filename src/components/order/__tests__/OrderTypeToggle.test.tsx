import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import OrderTypeToggle from "../OrderTypeToggle";

describe("OrderTypeToggle", () => {
  it("renders the toggle container", () => {
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={() => {}} />);
    expect(screen.getByTestId("order-type-toggle")).toBeInTheDocument();
  });

  it("renders Pickup and Delivery buttons", () => {
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={() => {}} />);
    expect(screen.getByTestId("toggle-pickup")).toHaveTextContent("Pickup");
    expect(screen.getByTestId("toggle-delivery")).toHaveTextContent("Delivery");
  });

  it("highlights Pickup when orderType is pickup", () => {
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={() => {}} />);
    const pickup = screen.getByTestId("toggle-pickup");
    const delivery = screen.getByTestId("toggle-delivery");
    expect(pickup.className).toContain("bg-gold");
    expect(delivery.className).not.toContain("bg-gold");
  });

  it("highlights Delivery when orderType is delivery", () => {
    render(<OrderTypeToggle orderType="delivery" onOrderTypeChange={() => {}} />);
    const pickup = screen.getByTestId("toggle-pickup");
    const delivery = screen.getByTestId("toggle-delivery");
    expect(pickup.className).not.toContain("bg-gold");
    expect(delivery.className).toContain("bg-gold");
  });

  it("calls onOrderTypeChange with 'pickup' when Pickup is clicked", () => {
    const handler = vi.fn();
    render(<OrderTypeToggle orderType="delivery" onOrderTypeChange={handler} />);
    fireEvent.click(screen.getByTestId("toggle-pickup"));
    expect(handler).toHaveBeenCalledWith("pickup");
  });

  it("calls onOrderTypeChange with 'delivery' when Delivery is clicked", () => {
    const handler = vi.fn();
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={handler} />);
    fireEvent.click(screen.getByTestId("toggle-delivery"));
    expect(handler).toHaveBeenCalledWith("delivery");
  });

  it("sets aria-pressed correctly for pickup", () => {
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={() => {}} />);
    expect(screen.getByTestId("toggle-pickup")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("toggle-delivery")).toHaveAttribute("aria-pressed", "false");
  });

  it("sets aria-pressed correctly for delivery", () => {
    render(<OrderTypeToggle orderType="delivery" onOrderTypeChange={() => {}} />);
    expect(screen.getByTestId("toggle-pickup")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("toggle-delivery")).toHaveAttribute("aria-pressed", "true");
  });
});
