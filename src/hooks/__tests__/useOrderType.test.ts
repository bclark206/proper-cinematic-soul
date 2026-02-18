// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useOrderType } from "../useOrderType";

const STORAGE_KEY = "proper-cuisine-order-type";

// Mock localStorage since Node.js built-in localStorage conflicts with jsdom
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
};

Object.defineProperty(window, "localStorage", { value: mockLocalStorage });

describe("useOrderType", () => {
  beforeEach(() => {
    delete store[STORAGE_KEY];
    vi.clearAllMocks();
  });

  it("defaults to pickup when no stored value", () => {
    const { result } = renderHook(() => useOrderType());
    expect(result.current.orderType).toBe("pickup");
  });

  it("reads stored value from localStorage", () => {
    store[STORAGE_KEY] = "delivery";
    const { result } = renderHook(() => useOrderType());
    expect(result.current.orderType).toBe("delivery");
  });

  it("ignores invalid stored values", () => {
    store[STORAGE_KEY] = "invalid";
    const { result } = renderHook(() => useOrderType());
    expect(result.current.orderType).toBe("pickup");
  });

  it("updates orderType and persists to localStorage", () => {
    const { result } = renderHook(() => useOrderType());
    act(() => {
      result.current.setOrderType("delivery");
    });
    expect(result.current.orderType).toBe("delivery");
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, "delivery");
  });

  it("can toggle back to pickup", () => {
    const { result } = renderHook(() => useOrderType());
    act(() => {
      result.current.setOrderType("delivery");
    });
    act(() => {
      result.current.setOrderType("pickup");
    });
    expect(result.current.orderType).toBe("pickup");
    expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith(STORAGE_KEY, "pickup");
  });
});
