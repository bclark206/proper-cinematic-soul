import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Valentines from '../Valentines';

describe('Valentines Page', () => {
  it('renders without crashing', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/Valentine's Day Weekend at/i)).toBeInTheDocument();
  });

  it('displays the hero heading with Proper Cuisine', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/Proper Cuisine/i)).toBeInTheDocument();
  });

  it('displays the date range', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/February 14-16, 2026/i)).toBeInTheDocument();
  });

  it('displays What to Expect section', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/What to Expect/i)).toBeInTheDocument();
    expect(screen.getByText(/90-Minute Table Times/i)).toBeInTheDocument();
  });

  it('displays the menu sections', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/Limited Valentine's Menu/i)).toBeInTheDocument();
    expect(screen.getByText(/Starters/i)).toBeInTheDocument();
    expect(screen.getByText(/Entrées/i)).toBeInTheDocument();
    expect(screen.getByText(/Desserts/i)).toBeInTheDocument();
  });

  it('displays menu items', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    // Check starters
    expect(screen.getByText(/Crab Balls/i)).toBeInTheDocument();
    expect(screen.getByText(/Devil Eggs/i)).toBeInTheDocument();

    // Check entrees
    expect(screen.getByText(/Honey Jerk Lamb/i)).toBeInTheDocument();
    expect(screen.getByText(/Salmon Pasta/i)).toBeInTheDocument();

    // Check desserts
    expect(screen.getByText(/Chocolate Lava Cake/i)).toBeInTheDocument();
  });

  it('displays parking information', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/Parking Information/i)).toBeInTheDocument();
    expect(screen.getByText(/Baltimore City Parking - Redwood Garage/i)).toBeInTheDocument();
    expect(screen.getByText(/112 E Redwood St/i)).toBeInTheDocument();
  });

  it('displays contact information', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    expect(screen.getByText(/206 E Redwood St/i)).toBeInTheDocument();
    expect(screen.getByText(/Baltimore, MD 21202/i)).toBeInTheDocument();
  });

  it('displays reservation CTA button', () => {
    render(
      <BrowserRouter>
        <Valentines />
      </BrowserRouter>
    );

    const reserveButton = screen.getByRole('link', { name: /Reserve Now/i });
    expect(reserveButton).toBeInTheDocument();
    expect(reserveButton).toHaveAttribute('href', expect.stringContaining('opentable.com'));
  });
});
