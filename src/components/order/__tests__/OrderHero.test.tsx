import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import OrderHero from "../OrderHero";

describe("OrderHero", () => {
  it("renders the hero section", () => {
    render(<OrderHero />);
    expect(screen.getByTestId("order-hero")).toBeInTheDocument();
  });

  it("displays the restaurant name", () => {
    render(<OrderHero />);
    expect(screen.getByText("Proper Cuisine")).toBeInTheDocument();
  });

  it("displays the heading with gold-accented Online text", () => {
    render(<OrderHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Order Online");
    const goldSpan = heading.querySelector(".text-gold");
    expect(goldSpan).toBeInTheDocument();
    expect(goldSpan).toHaveTextContent("Online");
  });

  it("displays the description text", () => {
    render(<OrderHero />);
    expect(
      screen.getByText(/Enjoy our signature dishes/i)
    ).toBeInTheDocument();
  });

  it("displays all three info chips", () => {
    render(<OrderHero />);
    expect(screen.getByText(/20–45 min prep/)).toBeInTheDocument();
    expect(screen.getByText(/Pickup Only/)).toBeInTheDocument();
    expect(screen.getByText(/\(443\) 432-2771/)).toBeInTheDocument();
  });

  it("renders the background image with aria-hidden", () => {
    const { container } = render(<OrderHero />);
    const img = container.querySelector('img[aria-hidden="true"]');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute(
      "src",
      expect.stringContaining("lovable-uploads")
    );
  });

  it("applies subtle opacity to the background image", () => {
    const { container } = render(<OrderHero />);
    const img = container.querySelector("img");
    expect(img?.className).toContain("opacity-15");
  });

  it("has responsive heading text sizes", () => {
    render(<OrderHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.className).toContain("text-3xl");
    expect(heading.className).toContain("sm:text-5xl");
    expect(heading.className).toContain("md:text-6xl");
    expect(heading.className).toContain("lg:text-7xl");
  });

  it("has backdrop blur on info chips", () => {
    const { container } = render(<OrderHero />);
    const chips = container.querySelectorAll(".backdrop-blur-sm");
    expect(chips.length).toBe(3);
  });
});
