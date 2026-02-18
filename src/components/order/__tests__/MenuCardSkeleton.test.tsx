import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MenuCardSkeleton from "../MenuCardSkeleton";

describe("MenuCardSkeleton", () => {
  it("renders skeleton card with test id", () => {
    render(<MenuCardSkeleton />);
    expect(screen.getByTestId("menu-card-skeleton")).toBeInTheDocument();
  });

  it("has the same rounded card styling as MenuCard", () => {
    render(<MenuCardSkeleton />);
    const card = screen.getByTestId("menu-card-skeleton");
    expect(card.className).toContain("rounded-xl");
    expect(card.className).toContain("bg-[#131313]");
    expect(card.className).toContain("border");
  });

  it("renders skeleton elements with pulse animation", () => {
    const { container } = render(<MenuCardSkeleton />);
    const pulsingElements = container.querySelectorAll(".animate-pulse");
    expect(pulsingElements.length).toBeGreaterThanOrEqual(2);
  });

  it("has responsive aspect ratio matching MenuCard", () => {
    const { container } = render(<MenuCardSkeleton />);
    const imageArea = container.querySelector(".aspect-square");
    expect(imageArea).toBeInTheDocument();
    expect(imageArea?.className).toContain("sm:aspect-[3/2]");
  });
});
