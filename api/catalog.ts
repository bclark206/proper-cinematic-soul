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
  "protein": { slug: "protein", name: "Proteins & Add-Ons", order: 7 },
  "sides": { slug: "sides", name: "Sides", order: 8 },
  "desserts": { slug: "desserts", name: "Desserts", order: 9 },
};

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

      // Find the matching food category from the item's categories array
      const itemCatIds = (d.categories || []).map((c) => c.id);
      if (d.category_id) itemCatIds.push(d.category_id);

      let catInfo: { slug: string; name: string; order: number } | undefined;
      for (const cid of itemCatIds) {
        const info = categorySlugMap.get(cid);
        if (info) { catInfo = info; break; }
      }
      if (!catInfo) continue; // Skip non-food items

      const variations = (d.variations || []).map((v) => ({
        id: v.id,
        name: v.item_variation_data?.name || "Regular",
        price: v.item_variation_data?.price_money?.amount || 0,
      }));

      const firstPrice = variations.length > 0 ? variations[0].price : 0;
      const imageId = d.image_ids?.[0] || null;
      const imageUrl = imageId ? imagesById.get(imageId) || null : null;

      const modListIds = (d.modifier_list_info || []).map((m) => m.modifier_list_id);

      menuItems.push({
        id: item.id,
        name: titleCase(d.name || ""),
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
    const categories = Array.from(categorySlugMap.values())
      .filter((c) => usedSlugs.has(c.slug))
      .sort((a, b) => a.order - b.order)
      .filter((c) => { if (seenSlugs.has(c.slug)) return false; seenSlugs.add(c.slug); return true; })
      .map(({ slug, name }) => ({ slug, name }));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300", // 5 min CDN cache
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
