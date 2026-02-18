import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { Badge } from "../ui/badge";
import MenuCard from "../order/MenuCard";
import FloatingCart from "../order/FloatingCart";
import CategoryNav from "../order/CategoryNav";
import OrderTypeToggle from "../order/OrderTypeToggle";
import Footer from "../Footer";
import type { MenuItem, Category } from "@/data/menu";

// Helpers
const focusVisibleRing = "focus-visible:ring-2";
const focusVisibleOutline = "focus-visible:outline-none";

function hasClasses(el: Element, ...classes: string[]) {
  return classes.every((c) => el.className.includes(c));
}

// Test data
const baseItem: MenuItem = {
  id: "item-1",
  name: "Test Dish",
  description: "A test dish",
  category: "entrees",
  variations: [{ id: "var-1", name: "Regular", price: 1500 }],
  modifierListIds: [],
  imageId: null,
  price: 1500,
};

const categories: Category[] = [
  { slug: "appetizers", name: "Appetizers" },
  { slug: "entrees", name: "Entrees" },
];

describe("Interactive States - Buttons", () => {
  it("gold variant has focus-visible ring and shadow", () => {
    render(<Button variant="gold">Gold</Button>);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, focusVisibleRing, "focus-visible:shadow-gold")).toBe(true);
  });

  it("outline-gold variant has focus-visible ring", () => {
    render(<Button variant="outline-gold">Outline Gold</Button>);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, focusVisibleRing, focusVisibleOutline)).toBe(true);
  });

  it("hero variant has focus-visible ring and shadow", () => {
    render(<Button variant="hero">Hero</Button>);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, focusVisibleRing, "focus-visible:shadow-gold")).toBe(true);
  });

  it("dark-elegant variant has focus-visible ring", () => {
    render(<Button variant="dark-elegant">Dark</Button>);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, focusVisibleRing, focusVisibleOutline)).toBe(true);
  });

  it("default variant retains hover and focus states", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, "hover:bg-primary/90", focusVisibleRing)).toBe(true);
  });
});

describe("Interactive States - Form Controls", () => {
  it("Input has hover border and focus ring", () => {
    render(<Input placeholder="test" />);
    const input = screen.getByPlaceholderText("test");
    expect(hasClasses(input, "hover:border-ring/50", focusVisibleRing, "transition-colors")).toBe(true);
  });

  it("Textarea has hover border and focus ring", () => {
    render(<Textarea placeholder="test" />);
    const textarea = screen.getByPlaceholderText("test");
    expect(hasClasses(textarea, "hover:border-ring/50", focusVisibleRing, "transition-colors")).toBe(true);
  });

  it("Checkbox has hover border and focus ring", () => {
    render(<Checkbox data-testid="cb" />);
    const cb = screen.getByTestId("cb");
    expect(hasClasses(cb, "hover:border-ring", focusVisibleRing, "transition-colors")).toBe(true);
  });

  it("Switch has hover states for checked and unchecked", () => {
    render(<Switch data-testid="sw" />);
    const sw = screen.getByTestId("sw");
    expect(hasClasses(sw, "hover:data-[state=unchecked]:bg-input/80", "hover:data-[state=checked]:bg-primary/90")).toBe(true);
  });
});

describe("Interactive States - Badge", () => {
  it("outline badge has hover state", () => {
    render(<Badge variant="outline">Tag</Badge>);
    const badge = screen.getByText("Tag");
    expect(badge.className).toContain("hover:bg-accent/50");
  });

  it("default badge retains hover state", () => {
    render(<Badge>Tag</Badge>);
    const badge = screen.getByText("Tag");
    expect(badge.className).toContain("hover:bg-primary/80");
  });
});

describe("Interactive States - MenuCard", () => {
  it("has focus-visible ring for keyboard navigation", () => {
    const { container } = render(
      <MenuCard item={baseItem} onClick={vi.fn()} getItemImageUrl={vi.fn(() => null)} />
    );
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("focus-visible:ring-2");
    expect(btn?.className).toContain("focus-visible:outline-none");
    expect(btn?.className).toContain("focus-visible:ring-gold/50");
  });

  it("retains hover states", () => {
    const { container } = render(
      <MenuCard item={baseItem} onClick={vi.fn()} getItemImageUrl={vi.fn(() => null)} />
    );
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("hover:-translate-y-1.5");
    expect(btn?.className).toContain("hover:border-gold/30");
  });
});

describe("Interactive States - FloatingCart", () => {
  it("has focus-visible ring", () => {
    render(<FloatingCart itemCount={3} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(hasClasses(btn, "focus-visible:ring-2", focusVisibleOutline, "focus-visible:ring-gold/50")).toBe(true);
  });

  it("retains hover scale", () => {
    render(<FloatingCart itemCount={3} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("hover:scale-105");
  });
});

describe("Interactive States - CategoryNav", () => {
  it("category buttons have focus-visible ring", () => {
    render(
      <CategoryNav categories={categories} activeCategory="appetizers" onSelect={vi.fn()} />
    );
    const btn = screen.getByText("Entrees");
    expect(hasClasses(btn, "focus-visible:ring-2", focusVisibleOutline)).toBe(true);
  });

  it("inactive category retains hover states", () => {
    render(
      <CategoryNav categories={categories} activeCategory="appetizers" onSelect={vi.fn()} />
    );
    const btn = screen.getByText("Entrees");
    expect(btn.className).toContain("hover:text-gold");
  });
});

describe("Interactive States - OrderTypeToggle", () => {
  it("both toggle buttons have focus-visible ring", () => {
    render(<OrderTypeToggle orderType="pickup" onOrderTypeChange={vi.fn()} />);
    const pickupBtn = screen.getByTestId("toggle-pickup");
    const deliveryBtn = screen.getByTestId("toggle-delivery");
    expect(pickupBtn.className).toContain("focus-visible:ring-2");
    expect(deliveryBtn.className).toContain("focus-visible:ring-2");
    expect(pickupBtn.className).toContain("focus-visible:outline-none");
    expect(deliveryBtn.className).toContain("focus-visible:outline-none");
  });
});

describe("Interactive States - Footer", () => {
  it("social links have focus-visible ring", () => {
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>
    );
    const socialLinks = document.querySelectorAll("footer .flex.space-x-4 a");
    socialLinks.forEach((link) => {
      expect(link.className).toContain("focus-visible:ring-2");
      expect(link.className).toContain("focus-visible:outline-none");
    });
  });

  it("footer nav links have focus-visible ring", () => {
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>
    );
    const smsLink = screen.getByText("SMS Updates");
    const privacyLink = screen.getByText("Privacy Policy");
    const termsLink = screen.getByText("Terms & Conditions");
    [smsLink, privacyLink, termsLink].forEach((link) => {
      expect(link.className).toContain("focus-visible:ring-2");
      expect(link.className).toContain("focus-visible:outline-none");
    });
  });

  it("footer links retain hover states", () => {
    render(
      <BrowserRouter>
        <Footer />
      </BrowserRouter>
    );
    const smsLink = screen.getByText("SMS Updates");
    expect(smsLink.className).toContain("hover:text-gold");
  });
});
