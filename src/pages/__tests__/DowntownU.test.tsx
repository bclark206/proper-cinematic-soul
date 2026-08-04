import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import DowntownU from "../DowntownU";

const renderPage = () =>
  render(
    <BrowserRouter>
      <DowntownU />
    </BrowserRouter>,
  );

describe("Downtown U student meal plans", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("presents every plan, marks Scholar recommended, and lists included meals", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: /downtown u/i })).toBeInTheDocument();
    expect(screen.getByText("Flex 5")).toBeInTheDocument();
    expect(screen.getAllByText("Scholar 10").length).toBeGreaterThan(0);
    expect(screen.getByText("Resident 20")).toBeInTheDocument();
    expect(screen.getByText("Semester 40")).toBeInTheDocument();
    expect(screen.getByText("$60")).toBeInTheDocument();
    expect(screen.getAllByText("$110").length).toBeGreaterThan(0);
    expect(screen.getByText("$210")).toBeInTheDocument();
    expect(screen.getByText("$400")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("Proper Wing Meal")).toBeInTheDocument();
    expect(screen.getByText("Honey-Jerk Chicken Bowl")).toBeInTheDocument();
    expect(screen.getByText(/Salmon Bite Bowl/)).toHaveTextContent("+$2");
    expect(screen.getByText("Crab Cake Egg Rolls")).toBeInTheDocument();
    expect(screen.getByText("Cheesesteak Egg Rolls")).toBeInTheDocument();
    expect(screen.queryByText("Catfish & Fries")).not.toBeInTheDocument();
    expect(screen.queryByText("Proper Veggie Bowl")).not.toBeInTheDocument();
  });

  it("clearly explains eligibility, pickup/preorder, bulk availability, and allergens", () => {
    renderPage();

    expect(screen.getAllByText(/Morgan State or Coppin State/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/participating downtown housing/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/preorder before pickup/i)).toBeInTheDocument();
    expect(screen.getByText(/partner availability/i)).toBeInTheDocument();
    expect(screen.getByText(/cross-contact/i)).toBeInTheDocument();
  });

  it("fails closed without the complete reusable Square-link configuration", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent(/enrollment checkout is not configured/i);
    expect(screen.queryByRole("link", { name: /continue to square/i })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("contains no pilot cohort language", () => {
    renderPage();
    expect(document.body).not.toHaveTextContent(/60-day|100 students?/i);
  });
});
