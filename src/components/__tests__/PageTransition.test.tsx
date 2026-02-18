import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PageTransition from "../PageTransition";

function renderWithRouter(ui: React.ReactElement, initialEntries = ["/"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
  );
}

describe("PageTransition", () => {
  it("renders children", () => {
    renderWithRouter(
      <PageTransition>
        <div>Page content</div>
      </PageTransition>
    );
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("applies the page-transition class", () => {
    const { container } = renderWithRouter(
      <PageTransition>
        <div>Hello</div>
      </PageTransition>
    );
    const wrapper = container.firstElementChild;
    expect(wrapper).toHaveClass("page-transition");
  });

  it("uses location pathname as the key for re-mounting", () => {
    const { container, rerender } = render(
      <MemoryRouter initialEntries={["/"]}>
        <PageTransition>
          <div>Home</div>
        </PageTransition>
      </MemoryRouter>
    );

    const firstWrapper = container.firstElementChild;
    expect(firstWrapper).toHaveClass("page-transition");

    // Re-render with a new route to trigger re-mount
    rerender(
      <MemoryRouter initialEntries={["/order"]}>
        <PageTransition>
          <div>Order</div>
        </PageTransition>
      </MemoryRouter>
    );

    const secondWrapper = container.firstElementChild;
    expect(secondWrapper).toHaveClass("page-transition");
    expect(screen.getByText("Order")).toBeInTheDocument();
  });
});
