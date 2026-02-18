import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";

// Mock useMenu to avoid network requests
vi.mock("@/hooks/useMenu", () => ({
  useMenu: () => ({
    categories: [
      { slug: "small-plates", name: "Small Plates & Apps" },
      { slug: "entrees-land", name: "Entrees — Land" },
    ],
    loading: false,
    error: null,
    getMenuItemsByCategory: (slug: string) => {
      if (slug === "small-plates") {
        return [
          {
            id: "item-1",
            name: "Test Item",
            description: "A test menu item",
            category: "small-plates",
            variations: [{ id: "var-1", name: "Regular", price: 1200 }],
            modifierListIds: ["mod-list-1"],
            imageId: null,
            price: 1200,
          },
          {
            id: "item-2",
            name: "Another Item",
            description: "Another test item",
            category: "small-plates",
            variations: [{ id: "var-2", name: "Regular", price: 1500 }],
            modifierListIds: [],
            imageId: "img-1",
            price: 1500,
          },
        ];
      }
      return [
        {
          id: "item-3",
          name: "Land Item",
          description: "A land entree",
          category: "entrees-land",
          variations: [{ id: "var-3", name: "Regular", price: 3500 }],
          modifierListIds: [],
          imageId: null,
          price: 3500,
        },
      ];
    },
    getModifierList: () => undefined,
    getItemImageUrl: () => null,
  }),
}));

// Mock useCart
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

describe("Order Page - Mobile Responsive Layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders hero with compact mobile padding (py-10) and larger desktop (sm:py-24)", () => {
    const { container } = renderWithRouter(<Order />);
    const heroContent = container.querySelector(
      ".max-w-7xl.mx-auto.text-center"
    );
    expect(heroContent?.className).toContain("py-10");
    expect(heroContent?.className).toContain("sm:py-24");
  });

  it("renders hero heading with mobile-first text-3xl scaling up to lg:text-7xl", () => {
    const { container } = renderWithRouter(<Order />);
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("text-3xl");
    expect(h1?.className).toContain("sm:text-5xl");
    expect(h1?.className).toContain("lg:text-7xl");
  });

  it("renders hero subtitle label with xs text on mobile (text-xs) and sm on desktop", () => {
    const { container } = renderWithRouter(<Order />);
    const subtitle = container.querySelector("section p.text-gold\\/60");
    expect(subtitle?.className).toContain("text-xs");
    expect(subtitle?.className).toContain("sm:text-sm");
  });

  it("renders menu grid with 2 columns on mobile (grid-cols-2)", () => {
    const { container } = renderWithRouter(<Order />);
    const grid = container.querySelector(".grid.grid-cols-2");
    expect(grid).toBeInTheDocument();
    expect(grid?.className).toContain("lg:grid-cols-3");
  });

  it("renders main content with tight mobile padding (px-3) expanding for desktop (sm:px-6)", () => {
    const { container } = renderWithRouter(<Order />);
    const main = container.querySelector("main");
    expect(main?.className).toContain("px-3");
    expect(main?.className).toContain("sm:px-6");
  });

  it("renders main content with compact mobile vertical padding (py-6 sm:py-12)", () => {
    const { container } = renderWithRouter(<Order />);
    const main = container.querySelector("main");
    expect(main?.className).toContain("py-6");
    expect(main?.className).toContain("sm:py-12");
  });

  it("renders category sections with tighter mobile spacing (mb-10 sm:mb-16)", () => {
    const { container } = renderWithRouter(<Order />);
    const sections = container.querySelectorAll("main section");
    expect(sections.length).toBeGreaterThan(0);
    const firstSection = sections[0];
    expect(firstSection.className).toContain("mb-10");
    expect(firstSection.className).toContain("sm:mb-16");
  });

  it("renders category headings with mobile text-xl scaling to sm:text-3xl", () => {
    const { container } = renderWithRouter(<Order />);
    const categoryHeading = container.querySelector("main h2");
    expect(categoryHeading?.className).toContain("text-xl");
    expect(categoryHeading?.className).toContain("sm:text-3xl");
  });

  it("renders section header with compact mobile margin (mb-5 sm:mb-8)", () => {
    const { container } = renderWithRouter(<Order />);
    const headerDiv = container.querySelector("main section > div:first-child");
    expect(headerDiv?.className).toContain("mb-5");
    expect(headerDiv?.className).toContain("sm:mb-8");
  });

  it("renders menu grid with tight mobile gap (gap-3) and desktop gap (sm:gap-5)", () => {
    const { container } = renderWithRouter(<Order />);
    const grid = container.querySelector(".grid.grid-cols-2");
    expect(grid?.className).toContain("gap-3");
    expect(grid?.className).toContain("sm:gap-5");
  });
});

describe("Order Page - MenuCard Mobile Responsive", () => {
  it("renders menu cards with square aspect on mobile, 3:2 on desktop", () => {
    const { container } = renderWithRouter(<Order />);
    const imageAreas = container.querySelectorAll(".aspect-square");
    expect(imageAreas.length).toBeGreaterThan(0);
    imageAreas.forEach((area) => {
      expect(area.className).toContain("sm:aspect-[3/2]");
    });
  });

  it("renders menu card content with compact mobile padding (px-2.5)", () => {
    const { container } = renderWithRouter(<Order />);
    const cardContents = container.querySelectorAll("[class*='px-2.5'][class*='sm:px-5']");
    expect(cardContents.length).toBeGreaterThan(0);
  });

  it("renders menu card titles with smaller mobile text (text-[0.8rem])", () => {
    const { container } = renderWithRouter(<Order />);
    const cardTitle = container.querySelector("h3.font-display");
    expect(cardTitle?.className).toContain("text-[0.8rem]");
    expect(cardTitle?.className).toContain("sm:text-lg");
  });

  it("hides card descriptions on mobile (hidden sm:block)", () => {
    const { container } = renderWithRouter(<Order />);
    const descriptions = container.querySelectorAll("p.hidden.sm\\:block");
    expect(descriptions.length).toBeGreaterThan(0);
  });

  it("renders menu cards with active:scale tap feedback", () => {
    const { container } = renderWithRouter(<Order />);
    const cards = container.querySelectorAll("button[type='button']");
    const menuCards = Array.from(cards).filter((btn) =>
      btn.className.includes("active:scale-[0.98]")
    );
    expect(menuCards.length).toBeGreaterThan(0);
  });

  it("renders price badge with compact mobile sizing (text-xs, px-2)", () => {
    const { container } = renderWithRouter(<Order />);
    const priceBadge = container.querySelector(
      "[class*='absolute'][class*='top-2'][class*='right-2']"
    );
    expect(priceBadge).toBeInTheDocument();
    expect(priceBadge?.className).toContain("sm:top-3");
    expect(priceBadge?.className).toContain("sm:right-3");
  });
});

describe("Order Page - CategoryNav Mobile Responsive", () => {
  it("renders category nav with compact mobile padding (px-3 py-2)", () => {
    const { container } = renderWithRouter(<Order />);
    const navScroller = container.querySelector(
      "[role='navigation'] .overflow-x-auto"
    );
    expect(navScroller?.className).toContain("px-3");
    expect(navScroller?.className).toContain("py-2");
    expect(navScroller?.className).toContain("sm:px-6");
    expect(navScroller?.className).toContain("sm:py-3");
  });

  it("renders category buttons with smaller mobile text (text-xs sm:text-sm)", () => {
    const { container } = renderWithRouter(<Order />);
    const catButton = container.querySelector("[role='navigation'] button");
    expect(catButton?.className).toContain("text-xs");
    expect(catButton?.className).toContain("sm:text-sm");
  });

  it("renders category buttons with compact mobile padding (px-3.5 py-1.5)", () => {
    const { container } = renderWithRouter(<Order />);
    const catButton = container.querySelector("[role='navigation'] button");
    expect(catButton?.className).toContain("px-3.5");
    expect(catButton?.className).toContain("py-1.5");
    expect(catButton?.className).toContain("sm:px-5");
    expect(catButton?.className).toContain("sm:py-2");
  });

  it("renders category nav container with scroll-touch for native scrolling", () => {
    const { container } = renderWithRouter(<Order />);
    const navScroller = container.querySelector(
      "[role='navigation'] .overflow-x-auto"
    );
    expect(navScroller?.className).toContain("scroll-touch");
  });
});
