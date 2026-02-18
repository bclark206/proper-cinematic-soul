// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeliveryAddress } from "../useDeliveryAddress";

const STORAGE_KEY = "proper-cuisine-delivery-address";

const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
};

Object.defineProperty(window, "localStorage", { value: mockLocalStorage });

const EMPTY_ADDRESS = {
  street: "",
  apt: "",
  city: "",
  state: "",
  zip: "",
};

describe("useDeliveryAddress", () => {
  beforeEach(() => {
    delete store[STORAGE_KEY];
    vi.clearAllMocks();
  });

  it("defaults to empty address when no stored value", () => {
    const { result } = renderHook(() => useDeliveryAddress());
    expect(result.current.address).toEqual(EMPTY_ADDRESS);
  });

  it("reads stored address from localStorage", () => {
    const saved = {
      street: "123 Main St",
      apt: "4B",
      city: "Miami",
      state: "FL",
      zip: "33101",
    };
    store[STORAGE_KEY] = JSON.stringify(saved);
    const { result } = renderHook(() => useDeliveryAddress());
    expect(result.current.address).toEqual(saved);
  });

  it("handles invalid JSON in localStorage", () => {
    store[STORAGE_KEY] = "not-json";
    const { result } = renderHook(() => useDeliveryAddress());
    expect(result.current.address).toEqual(EMPTY_ADDRESS);
  });

  it("updates a single field via updateField", () => {
    const { result } = renderHook(() => useDeliveryAddress());
    act(() => {
      result.current.updateField("street", "456 Oak Ave");
    });
    expect(result.current.address.street).toBe("456 Oak Ave");
    expect(result.current.address.city).toBe("");
  });

  it("persists to localStorage on updateField", () => {
    const { result } = renderHook(() => useDeliveryAddress());
    act(() => {
      result.current.updateField("city", "Orlando");
    });
    const stored = JSON.parse(
      mockLocalStorage.setItem.mock.calls.at(-1)![1]
    );
    expect(stored.city).toBe("Orlando");
  });

  it("replaces the full address via setAddress", () => {
    const newAddr = {
      street: "789 Pine Rd",
      apt: "",
      city: "Tampa",
      state: "FL",
      zip: "33602",
    };
    const { result } = renderHook(() => useDeliveryAddress());
    act(() => {
      result.current.setAddress(newAddr);
    });
    expect(result.current.address).toEqual(newAddr);
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(newAddr)
    );
  });
});
