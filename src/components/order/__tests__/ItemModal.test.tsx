import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ItemModal from "../ItemModal";
import type { MenuItem, ModifierList } from "@/data/menu";

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

const sidesList: ModifierList = {
  id: "mod-sides",
  name: "Choose Two Sides",
  modifiers: [
    { id: "s1", name: "Fries", price: 0 },
    { id: "s2", name: "Mac & Cheese", price: 0 },
    { id: "s3", name: "Brussels Sprouts", price: 500 },
  ],
};

const proteinList: ModifierList = {
  id: "mod-protein",
  name: "Choose Protein",
  modifiers: [
    { id: "p1", name: "Chicken", price: 1200 },
    { id: "p2", name: "Shrimp", price: 1300 },
  ],
};

const itemWithModifiers: MenuItem = {
  ...baseItem,
  id: "item-2",
  name: "Power Bowl",
  modifierListIds: ["mod-sides", "mod-protein"],
};

const getModifierList = (id: string) => {
  if (id === "mod-sides") return sidesList;
  if (id === "mod-protein") return proteinList;
  return undefined;
};

const getItemImageUrl = vi.fn(() => null);

const defaultProps = {
  item: baseItem,
  open: true,
  onClose: vi.fn(),
  onAddToCart: vi.fn(),
  getModifierList,
  getItemImageUrl,
};

describe("ItemModal", () => {
  it("renders nothing when item is null", () => {
    const { container } = render(
      <ItemModal {...defaultProps} item={null} />
    );
    expect(container.querySelector("[role='dialog']")).not.toBeInTheDocument();
  });

  it("renders item name and description", () => {
    render(<ItemModal {...defaultProps} />);
    expect(screen.getByText("Grilled Salmon")).toBeInTheDocument();
    expect(
      screen.getByText("Atlantic salmon with lemon butter sauce")
    ).toBeInTheDocument();
  });

  it("renders formatted price inline with title", () => {
    render(<ItemModal {...defaultProps} />);
    expect(screen.getByText("$28.00")).toBeInTheDocument();
  });

  it("renders fallback description when item has no description", () => {
    const itemNoDesc = { ...baseItem, description: null };
    render(<ItemModal {...defaultProps} item={itemNoDesc} />);
    expect(
      screen.getByText("A Proper Cuisine signature dish.")
    ).toBeInTheDocument();
  });

  it("renders image with 4:3 aspect ratio when imageUrl is available", () => {
    const itemWithImage = { ...baseItem, imageUrl: "https://example.com/salmon.jpg" };
    const { container } = render(
      <ItemModal {...defaultProps} item={itemWithImage} />
    );
    const img = screen.getByAltText("Grilled Salmon");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://example.com/salmon.jpg");
    const imageWrapper = img.parentElement;
    expect(imageWrapper?.className).toContain("aspect-[4/3]");
  });

  it("renders placeholder icon when no image", () => {
    render(<ItemModal {...defaultProps} />);
    // Placeholder renders in portal (document.body), with a 3:2 aspect
    const allDivs = document.body.querySelectorAll("div");
    const placeholder = Array.from(allDivs).find((d) =>
      d.className.includes("aspect-[3/2]")
    );
    expect(placeholder).toBeDefined();
  });

  it("renders modifier lists with section headers", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    expect(screen.getByText("Choose Two Sides")).toBeInTheDocument();
    expect(screen.getByText("Choose Protein")).toBeInTheDocument();
    expect(screen.getByText("Fries")).toBeInTheDocument();
    expect(screen.getByText("Mac & Cheese")).toBeInTheDocument();
    expect(screen.getByText("Chicken")).toBeInTheDocument();
  });

  it("shows selection counter for two-sides list", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("toggles modifier selection on click", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    const fries = screen.getByText("Fries").closest("button")!;
    fireEvent.click(fries);
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // Click again to deselect
    fireEvent.click(fries);
    expect(screen.getByText("0/2")).toBeInTheDocument();
  });

  it("shows upcharge price for priced modifiers", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    expect(screen.getByText("+$5.00")).toBeInTheDocument();
    expect(screen.getByText("+$12.00")).toBeInTheDocument();
    expect(screen.getByText("+$13.00")).toBeInTheDocument();
  });

  it("enforces max 2 selections for two-sides list", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    fireEvent.click(screen.getByText("Fries").closest("button")!);
    fireEvent.click(screen.getByText("Mac & Cheese").closest("button")!);
    expect(screen.getByText("2/2")).toBeInTheDocument();
    // Adding a third should auto-remove the oldest (Fries)
    fireEvent.click(screen.getByText("Brussels Sprouts").closest("button")!);
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("increments and decrements quantity", () => {
    render(<ItemModal {...defaultProps} />);
    const inc = screen.getByLabelText("Increase quantity");
    const dec = screen.getByLabelText("Decrease quantity");
    expect(screen.getByText("1")).toBeInTheDocument();
    fireEvent.click(inc);
    expect(screen.getByText("2")).toBeInTheDocument();
    fireEvent.click(dec);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("does not go below quantity of 1", () => {
    render(<ItemModal {...defaultProps} />);
    const dec = screen.getByLabelText("Decrease quantity");
    fireEvent.click(dec);
    fireEvent.click(dec);
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("updates total price with modifiers and quantity", () => {
    render(<ItemModal {...defaultProps} item={itemWithModifiers} />);
    // Base price: $28.00
    expect(screen.getByText(/Add to Cart/)).toHaveTextContent("$28.00");
    // Select chicken (+$12)
    fireEvent.click(screen.getByText("Chicken").closest("button")!);
    expect(screen.getByText(/Add to Cart/)).toHaveTextContent("$40.00");
    // Increase quantity to 2
    fireEvent.click(screen.getByLabelText("Increase quantity"));
    expect(screen.getByText(/Add to Cart/)).toHaveTextContent("$80.00");
  });

  it("calls onAddToCart with correct data and resets state", () => {
    const onAddToCart = vi.fn();
    const onClose = vi.fn();
    render(
      <ItemModal
        {...defaultProps}
        item={itemWithModifiers}
        onAddToCart={onAddToCart}
        onClose={onClose}
      />
    );
    // Select a modifier
    fireEvent.click(screen.getByText("Chicken").closest("button")!);
    // Click add
    fireEvent.click(screen.getByText(/Add to Cart/));
    expect(onAddToCart).toHaveBeenCalledWith({
      itemId: "item-2",
      variationId: "var-1",
      name: "Power Bowl",
      basePrice: 2800,
      quantity: 1,
      modifiers: [
        {
          listId: "mod-protein",
          listName: "Choose Protein",
          modifierId: "p1",
          modifierName: "Chicken",
          price: 1200,
        },
      ],
      specialInstructions: "",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders special instructions textarea", () => {
    render(<ItemModal {...defaultProps} />);
    expect(screen.getByText("Special Instructions")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Allergies, preferences, modifications...")
    ).toBeInTheDocument();
  });

  it("uses pill-shaped modifier buttons (rounded-full)", () => {
    const { container } = render(
      <ItemModal {...defaultProps} item={itemWithModifiers} />
    );
    const modButton = screen.getByText("Fries").closest("button");
    expect(modButton?.className).toContain("rounded-full");
  });

  it("uses pill-shaped quantity controls (rounded-full)", () => {
    const { container } = render(<ItemModal {...defaultProps} />);
    const dec = screen.getByLabelText("Decrease quantity");
    const quantityWrapper = dec.parentElement;
    expect(quantityWrapper?.className).toContain("rounded-full");
  });

  it("uses pill-shaped add-to-cart button (rounded-full)", () => {
    render(<ItemModal {...defaultProps} />);
    const addBtn = screen.getByText(/Add to Cart/);
    expect(addBtn.className).toContain("rounded-full");
  });
});
