import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import FloatingCart from "../FloatingCart";

describe("FloatingCart", () => {
  it("renders nothing when itemCount is 0", () => {
    const { container } = render(
      <FloatingCart itemCount={0} onClick={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the cart button when itemCount > 0", () => {
    render(<FloatingCart itemCount={3} onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("displays the item count", () => {
    render(<FloatingCart itemCount={5} onClick={vi.fn()} />);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("displays 99+ when itemCount exceeds 99", () => {
    render(<FloatingCart itemCount={120} onClick={vi.fn()} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("calls onClick when the button is clicked", () => {
    const onClick = vi.fn();
    render(<FloatingCart itemCount={2} onClick={onClick} />);
    screen.getByRole("button").click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies pulse animation class when itemCount increases", () => {
    const { rerender } = render(
      <FloatingCart itemCount={1} onClick={vi.fn()} />
    );
    const button = screen.getByRole("button");
    expect(button.className).not.toContain("cart-pulse");

    rerender(<FloatingCart itemCount={2} onClick={vi.fn()} />);
    expect(button.className).toContain("cart-pulse");
  });

  it("removes pulse animation class after timeout", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <FloatingCart itemCount={1} onClick={vi.fn()} />
    );

    rerender(<FloatingCart itemCount={2} onClick={vi.fn()} />);
    expect(screen.getByRole("button").className).toContain("cart-pulse");

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByRole("button").className).not.toContain("cart-pulse");
    vi.useRealTimers();
  });

  it("does not pulse when itemCount decreases", () => {
    const { rerender } = render(
      <FloatingCart itemCount={3} onClick={vi.fn()} />
    );

    rerender(<FloatingCart itemCount={2} onClick={vi.fn()} />);
    expect(screen.getByRole("button").className).not.toContain("cart-pulse");
  });
});
