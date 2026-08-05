import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import DowntownU from "../DowntownU";

const renderPage = () =>
  render(
    <BrowserRouter>
      <DowntownU />
    </BrowserRouter>,
  );

describe("Downtown U student meal plans", () => {
  beforeEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/downtown-u"); });
  afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, "", "/downtown-u"); });

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

  it("links existing students to the protected portal without calling an API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderPage();
    expect(screen.getByRole("link", { name: /student sign in/i })).toHaveAttribute("href", "/downtown-u/portal");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("contains no pilot cohort language", () => {
    renderPage();
    expect(document.body).not.toHaveTextContent(/60-day|100 students?/i);
  });

  it.each([
    ["success", null],
    ["invalid", { authFailure: "invalid" }],
  ] as const)("safely strips the magic-bridge %s marker and redirects with only safe state", async (auth, expectedState) => {
    window.history.replaceState(null, "", `/downtown-u?auth=${auth}&unsafe=secret#credential`);
    renderPage();
    await waitFor(() => expect(window.location.pathname).toBe("/downtown-u/portal"));
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.history.state.usr).toEqual(expectedState);
    expect(document.body).not.toHaveTextContent(/challengeId|verifier/i);
  });
});
