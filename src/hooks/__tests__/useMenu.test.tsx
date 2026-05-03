// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useMenu } from "../useMenu";

const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
};

Object.defineProperty(window, "localStorage", { value: mockLocalStorage, configurable: true });

describe("useMenu", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        categories: [{ slug: "sides", name: "Sides" }],
        menuItems: [],
        modifierLists: [],
        imageMap: {},
        fetchedAt: "2026-05-03T00:00:00.000Z",
      }),
    }) as unknown as typeof fetch;
  });

  it("loads the live Vercel catalog API instead of stale GitHub raw catalog", async () => {
    const { result } = renderHook(() => useMenu());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(global.fetch).toHaveBeenCalledWith("/api/catalog", { cache: "no-store" });
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("raw.githubusercontent.com"));
  });
});
