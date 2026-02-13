# Valentine's Day Weekend Page - PRD

## Overview
Create a new `/valentines` page for Proper Cuisine's website (propercuisine.com). This is an informational page for Valentine's Day weekend guests.

## Tech Stack (MUST follow existing patterns)
- React + TypeScript + Vite
- Tailwind CSS + shadcn/ui components
- React Router (add route in App.tsx)
- Match the existing site's design language, fonts, and color scheme

## Tasks

- [x] Create `src/pages/Valentines.tsx` component
- [x] Add `/valentines` route in `src/App.tsx` (above the catch-all route)
- [x] Style the page to match the existing site design (check Index.tsx for reference)
- [x] Page should be elegant, romantic Valentine's Day themed (dark background, gold/rose accents)
- [x] Make it mobile-responsive

## Page Content (in order)

### Hero Section
- Large heading: "Valentine's Day Weekend at Proper Cuisine"
- Subheading: "February 14-16, 2026 | An Unforgettable Dining Experience"
- Brief romantic welcome message

### What to Expect
- We are expecting a busy and exciting weekend!
- 90-minute table times to ensure every couple gets a wonderful experience
- If your table is being prepared, our bar area will be available as a comfortable waiting space while your table is turned
- Reservations are highly recommended

### Limited Valentine's Menu
Display these items elegantly (maybe in a card grid or elegant list):

**Starters:**
- Crab Cake Egg Roll — Crabmeat, House Aioli
- Cheese Steak Egg Roll — Wagyu, House Aioli

**Salads:**
- Caesar Salad — Croutons, House Caesar
- Spinach Strawberry Salad — Balsamic Vinaigrette

**Entrées:**
- Red Snapper Étouffée — Fried Red Snapper, White Rice, Seafood Sauce
- Crab Cake — 8oz Jumbo Lump Crabmeat
- Creamy Salmon Pasta — Creamy Pasta, Salmon Filet, Bacon, Spinach
- Honey Jerk Lamb Chops — Signature Jerk Rub, Honey Glazed Lamb Chops

**Dessert:**
- Bread Pudding

### Parking Information
Display nearby parking options:
1. **Water Street Garage** - 208 Water Street
2. **One Light Street** - 1 Light Street
3. **Parkway** - 215 E Fayette St
4. **Valet Parking** - Hampton Inn, 131 E Redwood Street (if you're planning to stay there)

Note: "Street parking is also available. We recommend arriving 10-15 minutes early to find parking."

### Contact / Reservation CTA
- "Make a Reservation" button linking to Resy or the main site's reservation flow
- Restaurant address: 206 E Redwood St, Baltimore, MD 21202
- Phone for questions

## Design Notes
- Keep it classy — think candlelight dinner vibes
- Use the restaurant's existing color palette from the site
- Icons or emojis sparingly for visual interest
- No prices on the menu (Berry didn't specify prices)

## DO NOT
- Change any existing pages or components
- Remove or modify existing routes
- Install new dependencies (use what's already in package.json)
