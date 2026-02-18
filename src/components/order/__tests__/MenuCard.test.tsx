import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MenuCard from "../MenuCard";
import type { MenuItem } from "@/data/menu";

const baseItem: MenuItem = {
  id: "item-1",
  name: "Grilled Salmon",
  description: "Atlantic salmon with lemon butter sauce",
  category: "entrees-sea",
  variations: [{ id: "var-1", name: "Regular", price: 2800 }],
  modifierListIds: [],
  imageId: null,
  price: 2800,
};

const customizableItem: MenuItem = {
  ...baseItem,
  id: "item-2",
  name: "Ribeye Steak",
  description: null,
  modifierListIds: ["mod-list-1"],
};

const getItemImageUrl = vi.fn(() => null);

describe("MenuCard", () => {
  it("renders item name and description", () => {
    render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByText("Grilled Salmon")).toBeInTheDocument();
    expect(
      screen.getByText("Atlantic salmon with lemon butter sauce")
    ).toBeInTheDocument();
  });

  it("renders formatted price", () => {
    render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByText("$28.00")).toBeInTheDocument();
  });

  it("calls onClick with item when clicked", () => {
    const onClick = vi.fn();
    render(
      <MenuCard
        item={baseItem}
        onClick={onClick}
        getItemImageUrl={getItemImageUrl}
      />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledWith(baseItem);
  });

  it("shows Customizable badge when item has modifiers", () => {
    render(
      <MenuCard
        item={customizableItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByText("Customizable")).toBeInTheDocument();
  });

  it("hides Customizable badge when item has no modifiers", () => {
    render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.queryByText("Customizable")).not.toBeInTheDocument();
  });

  it("renders placeholder when no image is available", () => {
    render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByText("Proper Cuisine")).toBeInTheDocument();
  });

  it("renders image when imageUrl is available", () => {
    const itemWithImage = {
      ...baseItem,
      imageUrl: "https://example.com/salmon.jpg",
    };
    render(
      <MenuCard
        item={itemWithImage}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    const img = screen.getByAltText("Grilled Salmon");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/salmon.jpg");
  });

  it("renders image via getItemImageUrl when imageId is set", () => {
    const itemWithImageId: MenuItem = { ...baseItem, imageId: "img-123" };
    const mockGetUrl = vi.fn(() => "https://example.com/lookup.jpg");
    render(
      <MenuCard
        item={itemWithImageId}
        onClick={vi.fn()}
        getItemImageUrl={mockGetUrl}
      />
    );
    expect(mockGetUrl).toHaveBeenCalledWith("img-123");
    const img = screen.getByAltText("Grilled Salmon");
    expect(img).toHaveAttribute("src", "https://example.com/lookup.jpg");
  });

  it("does not render description when it is null", () => {
    render(
      <MenuCard
        item={customizableItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByText("Ribeye Steak")).toBeInTheDocument();
    // Only the name, price, and Customizable badge — no description paragraph
    const button = screen.getByRole("button");
    const paragraphs = button.querySelectorAll("p");
    expect(paragraphs).toHaveLength(0);
  });

  it("uses lazy loading on images", () => {
    const itemWithImage = {
      ...baseItem,
      imageUrl: "https://example.com/salmon.jpg",
    };
    render(
      <MenuCard
        item={itemWithImage}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    expect(screen.getByAltText("Grilled Salmon")).toHaveAttribute(
      "loading",
      "lazy"
    );
  });

  it("uses square aspect on mobile with 3/2 on larger screens", () => {
    const { container } = render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    const imageArea = container.querySelector(".aspect-square");
    expect(imageArea).toBeInTheDocument();
    expect(imageArea?.className).toContain("sm:aspect-[3/2]");
  });

  it("has hover translate and shadow classes on the card", () => {
    const { container } = render(
      <MenuCard
        item={baseItem}
        onClick={vi.fn()}
        getItemImageUrl={getItemImageUrl}
      />
    );
    const button = container.querySelector("button");
    expect(button?.className).toContain("hover:-translate-y-1.5");
    expect(button?.className).toContain("hover:shadow-");
  });
});
