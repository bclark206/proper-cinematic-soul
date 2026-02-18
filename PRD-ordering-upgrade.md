# PRD: Proper Cuisine Online Ordering Upgrade

## Context
Proper Cuisine (propercuisine.com/order) is a restaurant online ordering system built with React + TypeScript + Tailwind + shadcn/ui. The backend is a Node.js server on localhost:18802 that processes Square payments. The menu is loaded from a catalog.json file fetched from GitHub raw URL.

This is a REAL production restaurant site. Every change must work. Do not break existing payment flows.

## Brand
- Upscale casual restaurant in Baltimore
- Dark/moody aesthetic with gold accents
- Colors: black backgrounds, gold (#D4AF37 or similar warm gold), white text
- Font: elegant but readable
- Vibe: premium but approachable — think upscale soul food

## Tasks

### Design Improvements
- [x] Redesign the menu grid with better card layouts — larger food images, cleaner typography, subtle hover animations
- [x] Add smooth category scroll navigation with sticky header and active indicator
- [x] Improve the item detail modal — larger image, better description layout, cleaner modifier/option selection
- [x] Redesign the cart drawer with better spacing, item images, and a more premium checkout feel
- [x] Add a floating cart button that shows item count with a subtle pulse animation when items are added
- [x] Improve mobile responsiveness — the ordering page should feel like a native app on phones
- [x] Add a hero section at the top of the order page with restaurant branding (subtle, not overwhelming)
- [x] Add loading skeleton states for menu items while catalog loads
- [x] Improve the checkout page design — cleaner form layout, better payment method selection UI, order summary sidebar

### Delivery Option
- [x] Add an order type toggle at the top: "Pickup" vs "Delivery" with a clean toggle/tab UI
- [x] When "Delivery" is selected, show a delivery address form (street, apt, city, state, zip)
- [x] Add a delivery fee display ($5.00 flat rate) that adds to the order total
- [x] Add estimated delivery time display ("45-60 minutes")
- [x] Pass order type ("PICKUP" or "DELIVERY") + delivery address + delivery notes to the backend POST /create-order request body
- [x] Update the order confirmation page to show delivery address and estimated delivery time when order type is DELIVERY
- [x] Add delivery radius note: "We deliver within 5 miles of 206 E Redwood St"
- [x] **Backend**: Update /Users/oscarclark/.openclaw/workspace/proper-order-server/server.js — when orderType is "DELIVERY", create the Square order with fulfillments[0].type="DELIVERY" and delivery_details containing: recipient (display_name, phone_number, email_address), deliver_at (current time + 45 min in RFC3339), prep_time_duration "PT30M", delivery_window_duration "PT15M", note from delivery notes, and recipient.address (address_line_1, address_line_2, locality="Baltimore", administrative_district_level_1="MD", postal_code). For "PICKUP" orders keep existing pickup fulfillment logic.
- [x] **Backend**: Add $5 delivery fee as a service_charges entry on delivery orders: { name: "Delivery Fee", amount_money: { amount: 500, currency: "USD" }, calculation_phase: "SUBTOTAL_PHASE" }

### Polish
- [x] Add subtle page transitions/animations (framer-motion if available, CSS if not)
- [x] Ensure all interactive elements have proper hover/focus states
- [x] Add empty cart state with a friendly message and CTA to browse menu
- [x] Order confirmation page should feel celebratory — "Your order is on its way to the kitchen!"

## Technical Notes
- Repo: /Users/oscarclark/.openclaw/workspace/proper-cinematic-soul
- Backend server: /Users/oscarclark/.openclaw/workspace/proper-order-server/server.js (YES you can modify this for delivery)
- Framework: React + TypeScript + Vite + Tailwind + shadcn/ui
- Key files: src/pages/Order.tsx, src/components/order/*.tsx, src/hooks/useMenu.ts, src/hooks/useCart.ts
- Checkout: src/pages/OrderCheckout.tsx, src/pages/OrderConfirmation.tsx
- DO NOT change the Square Web Payments SDK card tokenization logic — it works
- Menu data comes from catalog.json — don't change the data fetching logic
- Run `npm run build` to verify no TypeScript errors before marking tasks done
- Commit after each logical group of changes
