/**
 * Serverless function: GET /api/catalog
 *
 * Fetches the full catalog from Square's Catalog API and returns
 * a simplified structure matching the front-end's MenuItem/Category/ModifierList types.
 *
 * Environment variables required:
 *   SQUARE_ACCESS_TOKEN — Square production access token
 *   SQUARE_LOCATION_ID  — Square location ID
 */

interface SquareCatalogObject {
  type: string;
  id: string;
  item_data?: {
    name?: string;
    description?: string;
    category_id?: string;
    categories?: Array<{ id: string }>;
    reporting_category?: { id: string };
    variations?: Array<{
      id: string;
      item_variation_data?: {
        name?: string;
        price_money?: { amount?: number; currency?: string };
      };
    }>;
    modifier_list_info?: Array<{
      modifier_list_id: string;
    }>;
    image_ids?: string[];
    is_archived?: boolean;
    ecom_visibility?: string;
    available_online?: boolean;
    present_at_all_locations?: boolean;
    absent_at_location_ids?: string[];
    present_at_location_ids?: string[];
  };
  category_data?: {
    name?: string;
    parent_category?: { id?: string };
  };
  modifier_list_data?: {
    name?: string;
    modifiers?: Array<{
      id: string;
      modifier_data?: {
        name?: string;
        price_money?: { amount?: number; currency?: string };
      };
    }>;
  };
  image_data?: {
    url?: string;
    name?: string;
  };
}

// Map Square category names → display slug/name/order
// Keys are lowercased for case-insensitive matching
const CATEGORY_DISPLAY: Record<string, { slug: string; name: string; order: number }> = {
  "apps": { slug: "small-plates", name: "Small Plates & Apps", order: 0 },
  "small plates": { slug: "small-plates", name: "Small Plates & Apps", order: 0 },
  "salads": { slug: "salads", name: "Salads", order: 1 },
  "entree/land": { slug: "entrees-land", name: "Entrees — Land", order: 2 },
  "entree/sea": { slug: "entrees-sea", name: "Entrees — Sea", order: 3 },
  "pasta": { slug: "pasta", name: "Pasta", order: 4 },
  "brunch": { slug: "brunch", name: "Brunch", order: 5 },
  "sandwiches": { slug: "sandwiches", name: "Sandwiches", order: 6 },
  "sides": { slug: "sides", name: "Sides", order: 8 },
  "desserts": { slug: "desserts", name: "Desserts", order: 9 },
};

const HIDDEN_CATEGORY_NAMES = new Set(["protein", "proteins & add-ons"]);

const ITEM_CATEGORY_OVERRIDES: Record<string, { slug: string; name: string; order: number }> = {
  // Square item: Valet Parking
  "5XVTSP77KO4AUWU6FEIGYTGZ": { slug: "valet-parking", name: "Valet Parking", order: 10 },
};

interface LegacyCatalogItemImage {
  id: string;
  name: string;
  imageUrl: string;
}

const LEGACY_IMAGE_FALLBACKS: LegacyCatalogItemImage[] = [
  { "id": "5XEQ6FV62RZ7VECDKR2KH67B", "name": "Surf And Turf Fries", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/60c49dcec579f040824c376451c336233b502d13/original.png" },
  { "id": "DFN63PAAP5USEYHSQHD5LRT3", "name": "Crab Cake Egg Rolls", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/45d76f0465f1b336f9e1970b9bfb0ae61eecc7df/original.jpeg" },
  { "id": "4RSTJXILEXYRMAE5G7HBH33U", "name": "Salmon Bites", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/44f40a8bd1cfdba977dc13a54b34c6889a0fb51a/original.jpeg" },
  { "id": "UZWT6B5OPU36WCKZ53J7YBKK", "name": "Build Your Own Pasta", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/1cd5fc61d25bcced5709d9b82799796553c853b4/original.jpeg" },
  { "id": "MCNXBDADU7RTSMXVWOBO4SYY", "name": "Caesar Salad", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/a14c7e7f487606bdb5429761983ff04b8404dc16/original.png" },
  { "id": "GR6CUML6RVECFMFCAFPZTTUL", "name": "Salmon Filet", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/2eb3c07a8c9e774e17b7f8ae975d13363b96c357/original.png" },
  { "id": "S5EUWB2OOSACXSG2MHEJ6CSH", "name": "Side Salad", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/5acd9ac1ab3e5d394350c53de8164b4fd01122d8/original.png" },
  { "id": "PKLRMJJ53HALFC2A5PJ3JVRP", "name": "Wings", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/b6646ff38f3f97cdb8882de90bbf39cd949182c6/original.png" },
  { "id": "AEZI3H23MEVHSBE6SB5LXSO4", "name": "Single Jumbo Lump Crab Cake", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/b11f22b78e9944bb7c66bfe53b0d71aa956e933b/original.png" },
  { "id": "HPL26HWWYNI3PL7AA6BBALYD", "name": "Honey Jerk Lamb Chops", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/9462024edfe36a4bc2378a2c8a6a94a3f4aba833/original.png" },
  { "id": "7KEHP5RHHCU557JI7Q34JGAG", "name": "Ultimate Seafood Pasta", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/05bad1e1f47d3059e219257286a8beab647c0914/original.png" },
  { "id": "NSZRQOVDN4723IUEJN46FS6E", "name": "Double Lump Crab Cake", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/e5ea8067d31f40bbae345824305a483245879c7c/original.png" },
  { "id": "XQ2VYFX2PGBV3ZGDX5TQ3VQF", "name": "Crab Cake Fries", "imageUrl": "https://items-images-production.s3.us-west-2.amazonaws.com/files/0661781d2bab38babdf9d8f12b50b92c771ca8ae/original.jpeg" },
];

const legacyImageFallbackByItemId = new Map(LEGACY_IMAGE_FALLBACKS.map((item) => [item.id, item.imageUrl]));
const legacyImageFallbackByName = new Map(LEGACY_IMAGE_FALLBACKS.map((item) => [normalizedItemName(item.name), item.imageUrl]));

function normalizedItemName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getLegacyImageUrl(itemId: string, itemName: string): string | null {
  return legacyImageFallbackByItemId.get(itemId) || legacyImageFallbackByName.get(normalizedItemName(itemName)) || null;
}

function titleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function handler(_event: { body?: string; httpMethod?: string }) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;

  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Server misconfigured — missing Square credentials" }),
    };
  }

  try {
    // Fetch entire catalog with pagination
    let allObjects: SquareCatalogObject[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL("https://connect.squareup.com/v2/catalog/list");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url.toString(), {
        headers: {
          "Square-Version": "2024-01-18",
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const err = await res.json();
        console.error("Square Catalog API error:", JSON.stringify(err));
        return {
          statusCode: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "Failed to fetch catalog", details: err }),
        };
      }

      const data = await res.json();
      if (data.objects) allObjects = allObjects.concat(data.objects);
      cursor = data.cursor;
    } while (cursor);

    // Build lookup maps
    const categoriesById = new Map<string, SquareCatalogObject>();
    const imagesById = new Map<string, string>();
    const modifierListsById = new Map<string, SquareCatalogObject>();
    const items: SquareCatalogObject[] = [];

    for (const obj of allObjects) {
      switch (obj.type) {
        case "CATEGORY":
          categoriesById.set(obj.id, obj);
          break;
        case "IMAGE":
          if (obj.image_data?.url) imagesById.set(obj.id, obj.image_data.url);
          break;
        case "MODIFIER_LIST":
          modifierListsById.set(obj.id, obj);
          break;
        case "ITEM":
          items.push(obj);
          break;
      }
    }

    // Build category slug map: Square category ID → slug info
    // Match any category whose name matches our known food categories (case-insensitive)
    const categorySlugMap = new Map<string, { slug: string; name: string; order: number }>();
    for (const [id, cat] of categoriesById) {
      const catName = (cat.category_data?.name || "").toLowerCase().trim();
      if (HIDDEN_CATEGORY_NAMES.has(catName)) continue;
      const display = CATEGORY_DISPLAY[catName];
      if (display) {
        categorySlugMap.set(id, display);
      }
    }

    // Build modifier lists
    const modifierLists = [];
    for (const [id, ml] of modifierListsById) {
      const mods = ml.modifier_list_data?.modifiers || [];
      modifierLists.push({
        id,
        name: ml.modifier_list_data?.name || "",
        modifiers: mods.map((m) => ({
          id: m.id,
          name: m.modifier_data?.name || "",
          price: m.modifier_data?.price_money?.amount || 0,
        })),
      });
    }

    // Build menu items
    const menuItems = [];
    for (const item of items) {
      const d = item.item_data;
      if (!d) continue;

      // Skip archived items
      if (d.is_archived) continue;

      // Real-time sync: respect Square ecom visibility and online availability.
      // ecom_visibility values: "VISIBLE", "HIDDEN", "UNAVAILABLE", "UNINDEXED".
      // Anything other than VISIBLE/UNINDEXED hides the item online.
      if (d.ecom_visibility && d.ecom_visibility !== "VISIBLE" && d.ecom_visibility !== "UNINDEXED") continue;
      if (d.available_online === false) continue;

      // Find the matching food category from the item's categories array
      const itemCatIds = (d.categories || []).map((c) => c.id);
      if (d.category_id) itemCatIds.push(d.category_id);

      let catInfo: { slug: string; name: string; order: number } | undefined;
      for (const cid of itemCatIds) {
        const info = categorySlugMap.get(cid);
        if (info) { catInfo = info; break; }
      }
      if (!catInfo) {
        catInfo = ITEM_CATEGORY_OVERRIDES[item.id];
      }
      if (!catInfo) continue; // Skip non-food items

      const variations = (d.variations || []).map((v) => ({
        id: v.id,
        name: v.item_variation_data?.name || "Regular",
        price: v.item_variation_data?.price_money?.amount || 0,
      }));

      const itemName = d.name || "";
      const firstPrice = variations.length > 0 ? variations[0].price : 0;
      const imageId = d.image_ids?.[0] || null;
      const imageUrl = imageId ? imagesById.get(imageId) || getLegacyImageUrl(item.id, itemName) : getLegacyImageUrl(item.id, itemName);

      const modListIds = (d.modifier_list_info || []).map((m) => m.modifier_list_id);

      menuItems.push({
        id: item.id,
        name: titleCase(itemName),
        description: d.description || null,
        category: catInfo.slug,
        variations,
        modifierListIds: modListIds,
        imageId,
        imageUrl,
        price: firstPrice,
      });
    }

    // Build categories list (only those that have items), deduplicated by slug
    const usedSlugs = new Set(menuItems.map((i) => i.category));
    const seenSlugs = new Set<string>();
    const categoryInfoBySlug = new Map<string, { slug: string; name: string; order: number }>();
    for (const info of categorySlugMap.values()) categoryInfoBySlug.set(info.slug, info);
    for (const info of Object.values(ITEM_CATEGORY_OVERRIDES)) categoryInfoBySlug.set(info.slug, info);

    const categories = Array.from(categoryInfoBySlug.values())
      .filter((c) => usedSlugs.has(c.slug))
      .sort((a, b) => a.order - b.order)
      .filter((c) => { if (seenSlugs.has(c.slug)) return false; seenSlugs.add(c.slug); return true; })
      .map(({ slug, name }) => ({ slug, name }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      },
      body: JSON.stringify({
        categories,
        menuItems,
        modifierLists,
        imageMap: Object.fromEntries(imagesById),
        fetchedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}

// Vercel adapter — wraps Netlify-style handler above for Vercel serverless runtime
export default async function vercelHandler(
  req: { method?: string; body?: unknown },
  res: {
    status: (code: number) => { send: (body: string) => void; json: (body: unknown) => void };
    setHeader: (k: string, v: string) => void;
  }
) {
  const event = {
    httpMethod: req.method,
    body: typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}),
  };
  const result = await handler(event);
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, String(v));
  }
  res.status(result.statusCode).send(result.body);
}
