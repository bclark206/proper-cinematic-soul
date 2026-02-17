# PRD: Online Ordering for Proper Cuisine

## Overview
Build a custom online ordering page at `/order` on propercuisine.com (React/TypeScript site). Uses Square APIs as the backend — catalog, orders, payments. Orders automatically appear on the restaurant's Square POS/KDS.

## IMPORTANT: Use the front end design skill for all UI work. Make it look premium and modern — this is an upscale restaurant.

## Tech Stack
- React + TypeScript (existing site uses Vite, Tailwind CSS, shadcn/ui)
- Square Web Payments SDK for checkout
- Square Catalog API for menu data
- Square Orders API for order creation
- Square Payments API for payment processing

## Square Credentials
- **App ID**: sq0idp-ckcAIc_AeKVuekaXP7rBSA
- **Access Token**: EAAAl_nbTHyhNiycDMRqTy70H0MNY3KW8Lhjtw2MlNhlTjKx5W99Bk1cvopj67es
- **Location ID**: LPPWSSV03BHK8 (PrimeXProper — primary location)
- **Environment**: Production

## Data Files (already in repo root)
- `square_catalog.json` — 100 menu items with IDs, prices, variations, image IDs
- `square_categories.json` — 38 categories
- `square_modifiers.json` — 4 modifier lists (sides, proteins, etc.)

## Pages & Components

### 1. `/order` — Menu Page
- Hero section with restaurant name, "Order Online" heading, pickup info
- Category tabs/sidebar for filtering (Apps, Entrees/Land, Entrees/Sea, Pasta, Salads, Sandwiches, Small Plates, Sides, Desserts, Drinks)
- Clean up duplicate categories — merge "Entree/Land" + "Entree/land", etc.
- Item cards showing: name, description, price, image (if available)
- Click item → modal with full details, modifier selection (sides, add-ons), quantity, special instructions
- "Add to Cart" button
- Floating cart icon with item count badge
- NOTE: For MVP, hardcode the catalog data from square_catalog.json rather than making live API calls from the frontend (avoid CORS issues). We can add a backend proxy later.

### 2. Cart Drawer/Panel
- Slide-out cart showing all items, quantities, modifiers, special instructions
- Edit quantity, remove items
- Subtotal, tax estimate (6% MD sales tax + 9% alcohol tax where applicable)
- "Proceed to Checkout" button
- Minimum order amount: $15

### 3. `/order/checkout` — Checkout Page
- Customer info: name, phone, email
- Pickup time selection (ASAP or schedule — 15 min increments, 20-45 min prep)
- Order summary
- Square Web Payments SDK card form (credit/debit, Apple Pay, Google Pay)
- Tip selection (15%, 20%, 25%, custom)
- "Place Order" button
- NOTE: Payment processing requires a backend/serverless function to call Square APIs securely. Create an API route or serverless function that:
  1. Creates the order via Square Orders API
  2. Processes payment via Square Payments API
  3. Returns confirmation

### 4. `/order/confirmation` — Confirmation Page
- Order number
- Estimated pickup time
- Order summary
- "Your order has been sent to the kitchen!"
- Restaurant address + map link

## Design Requirements
- Match existing site aesthetic (dark, cinematic, upscale)
- Mobile-first responsive design
- Smooth animations/transitions
- Food photography placeholders where no images exist
- Premium feel — this is NOT a fast food ordering site
- Use shadcn/ui components where possible
- Gold/amber accents on dark background (match site branding)

## Menu Organization (from catalog)
Group items into these display categories:
- **Small Plates & Apps**: Crab Cake Egg Rolls, Cheesesteak Egg Rolls, Wings, Salmon Bites, Fried Salmon Bites, Colossal Fried Shrimp, etc.
- **Salads**: Caesar Salad, Spinach & Strawberry Salad
- **Entrees - Land**: Honey Jerk Lamb Chops, Chicken & Waffles, etc.
- **Entrees - Sea**: Red Snapper, Salmon Filet, Crab Cake, etc.
- **Pasta**: Creamy Salmon Pasta, Build Your Own Pasta, Ultimate Seafood Pasta, Shrimp Alfredo
- **Sandwiches**: Any sandwich items
- **Sides**: Mac and Cheese, Mash Potatoes, Fries, Roasted Asparagus, Cream Spinach, Kale, Roasted Broccolini, Brussels
- **Desserts**: Bread Pudding, Sweet Potato Pound Cake
- **Drinks**: Non-alcoholic only for online ordering (Lemonade, Mango Lemonade, Coke, Sprite, Ginger Ale, etc.)

## Fulfillment
- **Pickup only** (no delivery for MVP)
- Prep time: 20-45 minutes depending on order size
- Restaurant hours for ordering: 12 PM - 10 PM (or match current operating hours)
- Customer gets text confirmation via phone number they provide

## Backend / Serverless Function
Create an API endpoint (can be a Netlify/Vercel serverless function, or a simple Express server) that handles:

```
POST /api/create-order
Body: { items: [...], customer: {...}, tip: number }
Response: { orderId, paymentId, confirmationNumber }
```

Steps:
1. Create order via `POST https://connect.squareup.com/v2/orders` with line items mapped to catalog variation IDs
2. Create payment via `POST https://connect.squareup.com/v2/payments` with the source_id from Web Payments SDK
3. Return confirmation

## Security Notes
- Square Access Token must NEVER be in frontend code
- Use environment variables for all secrets
- Web Payments SDK handles card tokenization client-side (PCI compliant)
- Only the nonce/token goes to the backend

## Out of Scope (Phase 2)
- Delivery
- Customer accounts / order history
- Loyalty points
- Promo codes (Square supports this, add later)
- Real-time order status tracking
- SMS notifications via Twilio (add later)

## Files to Create/Modify
- `src/pages/Order.tsx` — main menu/ordering page
- `src/pages/OrderCheckout.tsx` — checkout page
- `src/pages/OrderConfirmation.tsx` — confirmation page
- `src/components/order/` — MenuCard, CartDrawer, CategoryNav, ItemModal, etc.
- `src/hooks/useCart.ts` — cart state management
- `src/data/menu.ts` — processed catalog data from square_catalog.json
- `api/create-order.ts` or `netlify/functions/create-order.ts` — backend endpoint
- Update `src/App.tsx` with new routes
- DO NOT delete square_catalog.json, square_categories.json, square_modifiers.json from repo

## Git
- Commit frequently with descriptive messages
- Push to main when working — auto-deploys via Lovable/Cloudflare
