import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";

const mockUseMenu = vi.fn();

vi.mock("@/hooks/useMenu", () => ({
  useMenu: () => mockUseMenu(),
}));

vi.mock("@/hooks/useCart", () => ({
  useCart: () => ({
    items: [],
    isOpen: false,
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
  }),
}));

import Order from "../Order";

const renderWithRouter = (component: React.ReactElement) =>
  render(<BrowserRouter>{component}</BrowserRouter>);

describe("Order Page - Skeleton Loading State", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders skeleton cards when loading", () => {
    mockUseMenu.mockReturnValue({
      categories: [],
      loading: true,
      error: null,
      getMenuItemsByCategory: () => [],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    renderWithRouter(<Order />);
    expect(screen.getByTestId("menu-skeleton")).toBeInTheDocument();
    const skeletonCards = screen.getAllByTestId("menu-card-skeleton");
    expect(skeletonCards.length).toBeGreaterThan(0);
  });

  it("renders multiple skeleton sections to mimic real menu layout", () => {
    mockUseMenu.mockReturnValue({
      categories: [],
      loading: true,
      error: null,
      getMenuItemsByCategory: () => [],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    const { container } = renderWithRouter(<Order />);
    const grids = container.querySelectorAll("[data-testid='menu-skeleton'] .grid");
    expect(grids.length).toBe(3);
  });

  it("renders skeleton section headers with pulse animation", () => {
    mockUseMenu.mockReturnValue({
      categories: [],
      loading: true,
      error: null,
      getMenuItemsByCategory: () => [],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    const { container } = renderWithRouter(<Order />);
    const sectionHeaders = container.querySelectorAll(
      "[data-testid='menu-skeleton'] .animate-pulse"
    );
    expect(sectionHeaders.length).toBeGreaterThan(0);
  });

  it("does not render skeleton when not loading", () => {
    mockUseMenu.mockReturnValue({
      categories: [{ slug: "small-plates", name: "Small Plates" }],
      loading: false,
      error: null,
      getMenuItemsByCategory: () => [
        {
          id: "item-1",
          name: "Test Item",
          description: "Description",
          category: "small-plates",
          variations: [{ id: "var-1", name: "Regular", price: 1200 }],
          modifierListIds: [],
          imageId: null,
          price: 1200,
        },
      ],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    renderWithRouter(<Order />);
    expect(screen.queryByTestId("menu-skeleton")).not.toBeInTheDocument();
    expect(screen.queryByTestId("menu-card-skeleton")).not.toBeInTheDocument();
  });

  it("does not render skeleton when showing error", () => {
    mockUseMenu.mockReturnValue({
      categories: [],
      loading: false,
      error: "Failed to load menu",
      getMenuItemsByCategory: () => [],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    renderWithRouter(<Order />);
    expect(screen.queryByTestId("menu-skeleton")).not.toBeInTheDocument();
    expect(screen.getByText("Failed to load menu")).toBeInTheDocument();
  });

  it("skeleton grids use the same responsive columns as real menu", () => {
    mockUseMenu.mockReturnValue({
      categories: [],
      loading: true,
      error: null,
      getMenuItemsByCategory: () => [],
      getModifierList: () => undefined,
      getItemImageUrl: () => null,
    });

    const { container } = renderWithRouter(<Order />);
    const grids = container.querySelectorAll("[data-testid='menu-skeleton'] .grid");
    grids.forEach((grid) => {
      expect(grid.className).toContain("grid-cols-2");
      expect(grid.className).toContain("lg:grid-cols-3");
    });
  });
});
