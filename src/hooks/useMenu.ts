import { useState, useEffect, useCallback } from "react";
import type { MenuItem, ModifierList, Category } from "@/data/menu";

interface CatalogResponse {
  categories: Category[];
  menuItems: (MenuItem & { imageUrl?: string | null })[];
  modifierLists: ModifierList[];
  imageMap: Record<string, string>;
  fetchedAt: string;
}

const CACHE_KEY = "proper_catalog_cache";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(): CatalogResponse | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CatalogResponse & { _cachedAt: number };
    if (Date.now() - cached._cachedAt > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function setCache(data: CatalogResponse) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, _cachedAt: Date.now() }));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

export function useMenu() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [modifierLists, setModifierLists] = useState<ModifierList[]>([]);
  const [imageMap, setImageMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyData = useCallback((data: CatalogResponse) => {
    setCategories(data.categories);
    // Merge imageUrl into items so getItemImageUrl works
    setMenuItems(data.menuItems as MenuItem[]);
    setModifierLists(data.modifierLists);
    setImageMap(data.imageMap);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // Try cache first
      const cached = getCached();
      if (cached) {
        applyData(cached);
        setLoading(false);
        // Still refresh in background
        fetchFresh(false);
        return;
      }

      await fetchFresh(true);
    };

    const fetchFresh = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      setError(null);

      try {
        const res = await fetch("https://raw.githubusercontent.com/bclark206/proper-cinematic-soul/main/public/catalog.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: CatalogResponse = await res.json();

        if (!cancelled) {
          applyData(data);
          setCache(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to fetch catalog:", err);
          setError("Unable to load menu. Please try again.");
          setLoading(false);
        }
      }
    };

    load();

    return () => { cancelled = true; };
  }, [applyData]);

  const getMenuItemsByCategory = useCallback(
    (categorySlug: string) => menuItems.filter((item) => item.category === categorySlug),
    [menuItems]
  );

  const getModifierList = useCallback(
    (id: string) => modifierLists.find((ml) => ml.id === id),
    [modifierLists]
  );

  const getItemImageUrl = useCallback(
    (imageId: string | null): string | null => {
      if (!imageId) return null;
      // First check if the item has imageUrl directly (from API response)
      return imageMap[imageId] || null;
    },
    [imageMap]
  );

  return {
    categories,
    menuItems,
    modifierLists,
    loading,
    error,
    getMenuItemsByCategory,
    getModifierList,
    getItemImageUrl,
  };
}
