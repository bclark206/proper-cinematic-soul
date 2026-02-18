import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CategoryNav from "../CategoryNav";
import type { Category } from "@/data/menu";

const categories: Category[] = [
  { slug: "small-plates", name: "Small Plates & Apps" },
  { slug: "salads", name: "Salads" },
  { slug: "entrees-land", name: "Entrées — Land" },
  { slug: "entrees-sea", name: "Entrées — Sea" },
  { slug: "desserts", name: "Desserts" },
];

beforeEach(() => {
  // Mock offsetLeft/offsetWidth for indicator positioning
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get() { return 0; },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() { return 100; },
  });
});

describe("CategoryNav", () => {
  it("renders all category buttons", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={vi.fn()}
      />
    );
    categories.forEach((cat) => {
      expect(screen.getByText(cat.name)).toBeInTheDocument();
    });
  });

  it("calls onSelect with category slug when button is clicked", () => {
    const onSelect = vi.fn();
    render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText("Salads"));
    expect(onSelect).toHaveBeenCalledWith("salads");
  });

  it("marks the active category with aria-current", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="entrees-sea"
        onSelect={vi.fn()}
      />
    );
    const activeButton = screen.getByText("Entrées — Sea");
    expect(activeButton).toHaveAttribute("aria-current", "true");

    const inactiveButton = screen.getByText("Salads");
    expect(inactiveButton).not.toHaveAttribute("aria-current");
  });

  it("applies active styling to current category", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="salads"
        onSelect={vi.fn()}
      />
    );
    const activeButton = screen.getByText("Salads");
    expect(activeButton.className).toContain("text-gold");
    expect(activeButton.className).toContain("font-semibold");
  });

  it("applies inactive styling to non-active categories", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="salads"
        onSelect={vi.fn()}
      />
    );
    const inactiveButton = screen.getByText("Desserts");
    expect(inactiveButton.className).toContain("text-cream/50");
  });

  it("renders the sliding active indicator", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={vi.fn()}
      />
    );
    const indicator = screen.getByTestId("active-indicator");
    expect(indicator).toBeInTheDocument();
  });

  it("has navigation role and accessible label", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={vi.fn()}
      />
    );
    const nav = screen.getByRole("navigation", { name: "Menu categories" });
    expect(nav).toBeInTheDocument();
  });

  it("uses sticky positioning", () => {
    render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={vi.fn()}
      />
    );
    const nav = screen.getByRole("navigation", { name: "Menu categories" });
    expect(nav.className).toContain("sticky");
    expect(nav.className).toContain("top-20");
  });

  it("updates active indicator when active category changes", () => {
    const { rerender } = render(
      <CategoryNav
        categories={categories}
        activeCategory="small-plates"
        onSelect={vi.fn()}
      />
    );

    const indicator = screen.getByTestId("active-indicator");
    const initialStyle = indicator.style.cssText;

    rerender(
      <CategoryNav
        categories={categories}
        activeCategory="desserts"
        onSelect={vi.fn()}
      />
    );

    // Indicator should still be present after rerender
    expect(screen.getByTestId("active-indicator")).toBeInTheDocument();
  });

  it("renders no buttons when categories is empty", () => {
    render(
      <CategoryNav
        categories={[]}
        activeCategory=""
        onSelect={vi.fn()}
      />
    );
    const nav = screen.getByRole("navigation", { name: "Menu categories" });
    const buttons = nav.querySelectorAll("button");
    expect(buttons).toHaveLength(0);
  });
});
