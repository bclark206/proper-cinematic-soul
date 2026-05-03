import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../catalog";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function squareCatalogResponse(objects: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ objects }),
  };
}

const category = (id: string, name: string) => ({
  type: "CATEGORY",
  id,
  category_data: { name },
});

const item = (id: string, name: string, categoryId: string) => ({
  type: "ITEM",
  id,
  item_data: {
    name,
    categories: [{ id: categoryId }],
    variations: [
      {
        id: `${id}-var`,
        item_variation_data: {
          name: "Regular",
          price_money: { amount: 1000, currency: "USD" },
        },
      },
    ],
  },
});

describe("catalog sync transform", () => {
  beforeEach(() => {
    vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
    mockFetch.mockReset();
  });

  it("keeps Valet Parking item even when category is not mapped", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        {
          type: "CATEGORY",
          id: "cat-apps",
          category_data: { name: "Apps" },
        },
        {
          type: "ITEM",
          id: "FOODITEM1",
          item_data: {
            name: "Crab Cake Egg Rolls",
            categories: [{ id: "cat-apps" }],
            variations: [
              {
                id: "FOODVAR1",
                item_variation_data: { name: "Regular", price_money: { amount: 1200 } },
              },
            ],
          },
        },
        {
          type: "ITEM",
          id: "5XVTSP77KO4AUWU6FEIGYTGZ",
          item_data: {
            name: "Valet Parking",
            variations: [
              {
                id: "XAO23JRGGJXWIJ4BQYBITRDK",
                item_variation_data: { name: "Regular", price_money: { amount: 1500 } },
              },
            ],
          },
        },
      ])
    );

    const response = await handler({ httpMethod: "GET" });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    const valetItem = body.menuItems.find((item: { id: string }) => item.id === "5XVTSP77KO4AUWU6FEIGYTGZ");
    expect(valetItem).toBeTruthy();
    expect(valetItem.category).toBe("valet-parking");
    expect(valetItem.variations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "XAO23JRGGJXWIJ4BQYBITRDK" }),
      ])
    );

    expect(body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "valet-parking", name: "Valet Parking" }),
      ])
    );
  });

  it("does not expose the Proteins & Add-Ons Square category on the public ordering site", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        category("cat-protein", "Protein"),
        category("cat-sides", "Sides"),
        item("item-shrimp", "Shrimp", "cat-protein"),
        item("item-fries", "Fries", "cat-sides"),
      ])
    );

    const result = await handler({ httpMethod: "GET" });
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.categories).toEqual([{ slug: "sides", name: "Sides" }]);
    expect(body.menuItems.map((menuItem: { name: string }) => menuItem.name)).toEqual(["Fries"]);
  });
});
