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

  it("keeps legacy item photos when Square catalog omits image_ids", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        category("cat-apps", "Apps"),
        item("5XEQ6FV62RZ7VECDKR2KH67B", "Surf And Turf Fries", "cat-apps"),
      ])
    );

    const result = await handler({ httpMethod: "GET" });
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.menuItems[0]).toEqual(
      expect.objectContaining({
        name: "Surf And Turf Fries",
        imageUrl: "https://items-images-production.s3.us-west-2.amazonaws.com/files/60c49dcec579f040824c376451c336233b502d13/original.png",
      })
    );
  });

  it("hides items marked HIDDEN or UNAVAILABLE in Square (ecom_visibility)", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        category("cat-apps", "Apps"),
        {
          type: "ITEM",
          id: "ITEM-VISIBLE",
          item_data: {
            name: "Visible Item",
            categories: [{ id: "cat-apps" }],
            ecom_visibility: "VISIBLE",
            variations: [{ id: "v1", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-HIDDEN",
          item_data: {
            name: "Hidden Item",
            categories: [{ id: "cat-apps" }],
            ecom_visibility: "HIDDEN",
            variations: [{ id: "v2", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-UNAVAILABLE",
          item_data: {
            name: "Unavailable Item",
            categories: [{ id: "cat-apps" }],
            ecom_visibility: "UNAVAILABLE",
            variations: [{ id: "v3", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-OFFLINE",
          item_data: {
            name: "Offline Item",
            categories: [{ id: "cat-apps" }],
            available_online: false,
            variations: [{ id: "v4", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
      ])
    );

    const result = await handler({ httpMethod: "GET" });
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.menuItems.map((m: { name: string }) => m.name)).toEqual(["Visible Item"]);
  });

  it("hides items deleted in Square (is_deleted=true) and items absent at our location", async () => {
    vi.stubEnv("SQUARE_LOCATION_ID", "LOC1");
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        category("cat-apps", "Apps"),
        {
          type: "ITEM",
          id: "ITEM-DELETED",
          is_deleted: true,
          item_data: {
            name: "Deleted Item",
            categories: [{ id: "cat-apps" }],
            variations: [{ id: "vd", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-ABSENT",
          present_at_all_locations: true,
          absent_at_location_ids: ["LOC1"],
          item_data: {
            name: "Absent Item",
            categories: [{ id: "cat-apps" }],
            variations: [{ id: "va", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-OTHER-LOC",
          present_at_all_locations: false,
          present_at_location_ids: ["LOC2"],
          item_data: {
            name: "Other Location Item",
            categories: [{ id: "cat-apps" }],
            variations: [{ id: "vo", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
        {
          type: "ITEM",
          id: "ITEM-OK",
          present_at_all_locations: true,
          item_data: {
            name: "Ok Item",
            categories: [{ id: "cat-apps" }],
            variations: [{ id: "vk", item_variation_data: { name: "Regular", price_money: { amount: 1000 } } }],
          },
        },
      ])
    );

    const result = await handler({ httpMethod: "GET" });
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.menuItems.map((m: { name: string }) => m.name)).toEqual(["Ok Item"]);
  });
});
