import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Valentines from '../Valentines';

const renderValentines = () =>
  render(
    <BrowserRouter>
      <Valentines />
    </BrowserRouter>
  );

describe('Valentines Page', () => {
  it('renders without crashing', () => {
    renderValentines();
    expect(screen.getByText(/Valentine's Day Weekend at/i)).toBeInTheDocument();
  });

  it('displays the hero heading with Proper Cuisine', () => {
    renderValentines();
    expect(screen.getAllByText(/Proper Cuisine/i).length).toBeGreaterThanOrEqual(1);
  });

  it('displays the date range', () => {
    renderValentines();
    expect(screen.getByText(/February 14-16, 2026/i)).toBeInTheDocument();
  });

  it('displays What to Expect section with gold accent heading', () => {
    renderValentines();
    expect(screen.getByRole('heading', { name: /What to\s+Expect/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /90-Minute Table Times/i })).toBeInTheDocument();
  });

  it('displays all four expectation cards', () => {
    renderValentines();
    expect(screen.getByRole('heading', { name: /Busy & Exciting Weekend/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /90-Minute Table Times/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Comfortable Waiting Area/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Reservations Recommended/i })).toBeInTheDocument();
  });

  it('displays the menu sections', () => {
    renderValentines();
    expect(screen.getByText(/Limited Valentine's/i)).toBeInTheDocument();
    expect(screen.getByText(/Starters/i)).toBeInTheDocument();
    expect(screen.getByText(/Entrées/i)).toBeInTheDocument();
    expect(screen.getByText(/Desserts/i)).toBeInTheDocument();
  });

  it('displays menu items', () => {
    renderValentines();
    expect(screen.getByText(/Crab Balls/i)).toBeInTheDocument();
    expect(screen.getByText(/Devil Eggs/i)).toBeInTheDocument();
    expect(screen.getByText(/Honey Jerk Lamb/i)).toBeInTheDocument();
    expect(screen.getByText(/Salmon Pasta/i)).toBeInTheDocument();
    expect(screen.getByText(/Chocolate Lava Cake/i)).toBeInTheDocument();
  });

  it('displays parking information', () => {
    renderValentines();
    expect(screen.getByRole('heading', { name: /Parking\s+Information/i })).toBeInTheDocument();
    expect(screen.getByText(/Baltimore City Parking - Redwood Garage/i)).toBeInTheDocument();
    expect(screen.getByText(/112 E Redwood St/i)).toBeInTheDocument();
  });

  it('displays contact information', () => {
    renderValentines();
    expect(screen.getAllByText(/206 E Redwood St/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Baltimore, MD/i).length).toBeGreaterThanOrEqual(1);
  });

  it('displays reservation CTA button', () => {
    renderValentines();
    const reserveButtons = screen.getAllByRole('link', { name: /Reserve/i });
    const opentableLink = reserveButtons.find(
      (btn) => btn.getAttribute('href')?.includes('opentable.com')
    );
    expect(opentableLink).toBeDefined();
  });

  it('uses alternating light and dark section backgrounds', () => {
    const { container } = renderValentines();
    const sections = container.querySelectorAll('main > section');
    // Hero (dark), What to Expect (cream/light), Menu (dark), Parking (cream/light), Reservation (dark)
    expect(sections.length).toBe(5);
  });

  it('displays scroll indicator in hero', () => {
    renderValentines();
    expect(screen.getByText(/Scroll to explore/i)).toBeInTheDocument();
  });

  it('displays Reserve Your Table card', () => {
    renderValentines();
    expect(screen.getByRole('heading', { name: /Reserve Your Table/i })).toBeInTheDocument();
  });
});
