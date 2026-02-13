import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Index from '../Index';
import Valentines from '../Valentines';

const renderWithRouter = (component: React.ReactElement) =>
  render(<BrowserRouter>{component}</BrowserRouter>);

describe('Mobile Responsive - Index Page', () => {
  it('renders Hero with responsive text sizing classes', () => {
    const { container } = renderWithRouter(<Index />);
    const heroHeading = container.querySelector('h1');
    expect(heroHeading?.className).toContain('text-4xl');
    expect(heroHeading?.className).toContain('sm:text-5xl');
    expect(heroHeading?.className).toContain('md:text-7xl');
    expect(heroHeading?.className).toContain('lg:text-8xl');
  });

  it('renders Hero buttons with full-width on mobile', () => {
    const { container } = renderWithRouter(<Index />);
    const heroSection = container.querySelector('section');
    const buttons = heroSection?.querySelectorAll('a[href*="toasttab"], button');
    if (buttons && buttons.length > 0) {
      const firstButton = buttons[0].closest('[class]');
      expect(firstButton?.className).toContain('w-full');
      expect(firstButton?.className).toContain('sm:w-auto');
    }
  });

  it('renders About section with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const aboutSection = container.querySelector('#about');
    expect(aboutSection?.className).toContain('py-12');
    expect(aboutSection?.className).toContain('sm:py-16');
    expect(aboutSection?.className).toContain('md:py-24');
    expect(aboutSection?.className).toContain('px-4');
    expect(aboutSection?.className).toContain('sm:px-6');
  });

  it('renders About heading with responsive text sizes', () => {
    const { container } = renderWithRouter(<Index />);
    const aboutSection = container.querySelector('#about');
    const heading = aboutSection?.querySelector('h2');
    expect(heading?.className).toContain('text-3xl');
    expect(heading?.className).toContain('sm:text-4xl');
    expect(heading?.className).toContain('lg:text-6xl');
  });

  it('renders About stat cards with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const aboutSection = container.querySelector('#about');
    const statCards = aboutSection?.querySelectorAll('.rounded-2xl');
    expect(statCards!.length).toBeGreaterThan(0);
    const firstStat = statCards![0];
    expect(firstStat.className).toContain('p-4');
    expect(firstStat.className).toContain('sm:p-8');
  });

  it('renders Menu section with responsive grid columns', () => {
    const { container } = renderWithRouter(<Index />);
    const menuSection = container.querySelector('#menus');
    const grid = menuSection?.querySelector('.grid.sm\\:grid-cols-2.lg\\:grid-cols-3');
    expect(grid).toBeInTheDocument();
  });

  it('renders Menu section heading with responsive sizes', () => {
    const { container } = renderWithRouter(<Index />);
    const menuSection = container.querySelector('#menus');
    const heading = menuSection?.querySelector('h2');
    expect(heading?.className).toContain('text-3xl');
    expect(heading?.className).toContain('sm:text-4xl');
    expect(heading?.className).toContain('md:text-5xl');
  });

  it('renders Menu download section with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const menuSection = container.querySelector('#menus');
    const downloadSection = menuSection?.querySelector('.bg-gradient-gold.rounded-2xl');
    expect(downloadSection?.className).toContain('p-6');
    expect(downloadSection?.className).toContain('sm:p-8');
    expect(downloadSection?.className).toContain('md:p-12');
  });

  it('renders Gallery section with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const gallerySection = container.querySelector('#gallery');
    expect(gallerySection?.className).toContain('py-12');
    expect(gallerySection?.className).toContain('sm:py-16');
    expect(gallerySection?.className).toContain('md:py-24');
  });

  it('renders Gallery grid with 2-column mobile layout', () => {
    const { container } = renderWithRouter(<Index />);
    const gallerySection = container.querySelector('#gallery');
    const grid = gallerySection?.querySelector('.grid.grid-cols-2');
    expect(grid).toBeInTheDocument();
  });

  it('renders Gallery featured highlight with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const gallerySection = container.querySelector('#gallery');
    const featured = gallerySection?.querySelector('.bg-gradient-gold.rounded-2xl');
    expect(featured).toBeInTheDocument();
    const textArea = featured?.querySelector('[class*="p-6"]');
    expect(textArea?.className).toContain('sm:p-8');
    expect(textArea?.className).toContain('md:p-12');
  });

  it('renders Contact section with responsive grid', () => {
    const { container } = renderWithRouter(<Index />);
    const contactSection = container.querySelector('#contact');
    const grid = contactSection?.querySelector('.grid.sm\\:grid-cols-2');
    expect(grid).toBeInTheDocument();
  });

  it('renders Contact heading with responsive text sizes', () => {
    const { container } = renderWithRouter(<Index />);
    const contactSection = container.querySelector('#contact');
    const heading = contactSection?.querySelector('h2');
    expect(heading?.className).toContain('text-3xl');
    expect(heading?.className).toContain('sm:text-4xl');
  });

  it('renders Footer with intermediate sm grid breakpoint', () => {
    const { container } = renderWithRouter(<Index />);
    const footer = container.querySelector('footer');
    const grid = footer?.querySelector('.grid');
    expect(grid?.className).toContain('sm:grid-cols-2');
    expect(grid?.className).toContain('lg:grid-cols-4');
  });

  it('renders Footer with responsive padding', () => {
    const { container } = renderWithRouter(<Index />);
    const footer = container.querySelector('footer');
    expect(footer?.className).toContain('py-10');
    expect(footer?.className).toContain('sm:py-16');
    expect(footer?.className).toContain('px-4');
    expect(footer?.className).toContain('sm:px-6');
  });

  it('renders Navigation with mobile hamburger menu', () => {
    const { container } = renderWithRouter(<Index />);
    const mobileMenuBtn = container.querySelector('.lg\\:hidden button');
    expect(mobileMenuBtn).toBeInTheDocument();
  });

  it('hides desktop nav on mobile', () => {
    const { container } = renderWithRouter(<Index />);
    const desktopNav = container.querySelector('.hidden.lg\\:flex');
    expect(desktopNav).toBeInTheDocument();
  });
});

describe('Mobile Responsive - Valentines Page', () => {
  it('renders hero with responsive text sizing', () => {
    const { container } = renderWithRouter(<Valentines />);
    const heroHeading = container.querySelector('h1');
    expect(heroHeading?.className).toContain('text-3xl');
    expect(heroHeading?.className).toContain('sm:text-5xl');
    expect(heroHeading?.className).toContain('md:text-7xl');
    expect(heroHeading?.className).toContain('lg:text-8xl');
  });

  it('renders hero heart icon container with responsive margin', () => {
    const { container } = renderWithRouter(<Valentines />);
    const heartContainer = container.querySelector('.heartbeat')?.closest('div');
    expect(heartContainer?.className).toContain('mb-6');
    expect(heartContainer?.className).toContain('sm:mb-8');
  });

  it('renders all sections with responsive padding', () => {
    const { container } = renderWithRouter(<Valentines />);
    const sections = container.querySelectorAll('main > section');
    // All non-hero sections should have responsive padding
    const contentSections = Array.from(sections).slice(1);
    contentSections.forEach((section) => {
      expect(section.className).toContain('px-4');
      expect(section.className).toContain('sm:px-6');
    });
  });

  it('renders section headings with responsive text sizes', () => {
    const { container } = renderWithRouter(<Valentines />);
    const sections = container.querySelectorAll('main > section');
    const contentSections = Array.from(sections).slice(1);
    contentSections.forEach((section) => {
      const h2 = section.querySelector('h2');
      if (h2) {
        expect(h2.className).toContain('text-3xl');
        expect(h2.className).toContain('sm:text-4xl');
      }
    });
  });

  it('renders expectations grid with sm breakpoint', () => {
    const { container } = renderWithRouter(<Valentines />);
    const expectGrid = container.querySelector('.grid.sm\\:grid-cols-2');
    expect(expectGrid).toBeInTheDocument();
  });

  it('renders menu grid with sm:grid-cols-2 breakpoint', () => {
    const { container } = renderWithRouter(<Valentines />);
    const menuGrid = container.querySelector('.grid.sm\\:grid-cols-2.lg\\:grid-cols-3');
    expect(menuGrid).toBeInTheDocument();
  });

  it('renders menu cards with responsive padding', () => {
    const { container } = renderWithRouter(<Valentines />);
    const menuCards = container.querySelectorAll('.border-gold\\/15');
    expect(menuCards.length).toBe(3);
    menuCards.forEach((card) => {
      const content = card.querySelector('[class*="p-5"]');
      expect(content).toBeInTheDocument();
      expect(content?.className).toContain('sm:p-8');
    });
  });

  it('renders contact grid with responsive gap', () => {
    const { container } = renderWithRouter(<Valentines />);
    const sections = container.querySelectorAll('main > section');
    const ctaSection = sections[sections.length - 1];
    const grid = ctaSection.querySelector('.grid.lg\\:grid-cols-3');
    expect(grid?.className).toContain('gap-6');
    expect(grid?.className).toContain('sm:gap-8');
  });
});
