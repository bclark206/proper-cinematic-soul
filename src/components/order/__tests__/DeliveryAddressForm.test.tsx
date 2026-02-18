import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DeliveryAddressForm from "../DeliveryAddressForm";
import type { DeliveryAddress } from "@/hooks/useDeliveryAddress";

const emptyAddress: DeliveryAddress = {
  street: "",
  apt: "",
  city: "",
  state: "",
  zip: "",
};

describe("DeliveryAddressForm", () => {
  it("renders the form container", () => {
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={() => {}} />
    );
    expect(screen.getByTestId("delivery-address-form")).toBeInTheDocument();
  });

  it("renders all address fields", () => {
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={() => {}} />
    );
    expect(screen.getByTestId("delivery-street")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-apt")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-city")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-state")).toBeInTheDocument();
    expect(screen.getByTestId("delivery-zip")).toBeInTheDocument();
  });

  it("renders labels for each field", () => {
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={() => {}} />
    );
    expect(screen.getByLabelText("Street Address")).toBeInTheDocument();
    expect(screen.getByLabelText("Apt / Suite (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("City")).toBeInTheDocument();
    expect(screen.getByLabelText("State")).toBeInTheDocument();
    expect(screen.getByLabelText("ZIP Code")).toBeInTheDocument();
  });

  it("displays the header with icon", () => {
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={() => {}} />
    );
    expect(screen.getByText("Delivery Address")).toBeInTheDocument();
  });

  it("displays current address values", () => {
    const address: DeliveryAddress = {
      street: "123 Main St",
      apt: "Apt 4B",
      city: "Miami",
      state: "FL",
      zip: "33101",
    };
    render(
      <DeliveryAddressForm address={address} onFieldChange={() => {}} />
    );
    expect(screen.getByTestId("delivery-street")).toHaveValue("123 Main St");
    expect(screen.getByTestId("delivery-apt")).toHaveValue("Apt 4B");
    expect(screen.getByTestId("delivery-city")).toHaveValue("Miami");
    expect(screen.getByTestId("delivery-state")).toHaveValue("FL");
    expect(screen.getByTestId("delivery-zip")).toHaveValue("33101");
  });

  it("calls onFieldChange with correct field and value when street changes", () => {
    const handler = vi.fn();
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={handler} />
    );
    fireEvent.change(screen.getByTestId("delivery-street"), {
      target: { value: "456 Oak Ave" },
    });
    expect(handler).toHaveBeenCalledWith("street", "456 Oak Ave");
  });

  it("calls onFieldChange with correct field and value when apt changes", () => {
    const handler = vi.fn();
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={handler} />
    );
    fireEvent.change(screen.getByTestId("delivery-apt"), {
      target: { value: "Suite 200" },
    });
    expect(handler).toHaveBeenCalledWith("apt", "Suite 200");
  });

  it("calls onFieldChange with correct field and value when city changes", () => {
    const handler = vi.fn();
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={handler} />
    );
    fireEvent.change(screen.getByTestId("delivery-city"), {
      target: { value: "Orlando" },
    });
    expect(handler).toHaveBeenCalledWith("city", "Orlando");
  });

  it("calls onFieldChange with correct field and value when state changes", () => {
    const handler = vi.fn();
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={handler} />
    );
    fireEvent.change(screen.getByTestId("delivery-state"), {
      target: { value: "FL" },
    });
    expect(handler).toHaveBeenCalledWith("state", "FL");
  });

  it("calls onFieldChange with correct field and value when zip changes", () => {
    const handler = vi.fn();
    render(
      <DeliveryAddressForm address={emptyAddress} onFieldChange={handler} />
    );
    fireEvent.change(screen.getByTestId("delivery-zip"), {
      target: { value: "32801" },
    });
    expect(handler).toHaveBeenCalledWith("zip", "32801");
  });
});
