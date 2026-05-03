import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../validate-promo";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function squareCatalogResponse(objects: unknown[]) {
  return { ok: true, json: () => Promise.resolve({ objects }) };
}

describe("validate-promo", () => {
  beforeEach(() => {
    vi.stubEnv("SQUARE_ACCESS_TOKEN", "test-token");
    mockFetch.mockReset();
  });

  it("returns 400 when code is missing", async () => {
    const res = await handler({ queryStringParameters: {} });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown code", async () => {
    mockFetch.mockResolvedValueOnce(squareCatalogResponse([]));
    const res = await handler({ queryStringParameters: { code: "BOGUS", subtotal: "5000" } });
    expect(res.statusCode).toBe(404);
  });

  it("validates a Square fixed-percentage discount and returns calculated cents", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        {
          type: "DISCOUNT",
          id: "DISC1",
          discount_data: {
            name: "WELCOME10",
            discount_type: "FIXED_PERCENTAGE",
            percentage: "10.0",
          },
        },
      ])
    );

    const res = await handler({ queryStringParameters: { code: "welcome10", subtotal: "5000" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("WELCOME10");
    expect(body.discount).toBe(500); // 10% of 5000
    expect(body.catalogObjectId).toBe("DISC1");
  });

  it("validates a Square fixed-amount discount", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        {
          type: "DISCOUNT",
          id: "DISC2",
          discount_data: {
            name: "5OFF",
            discount_type: "FIXED_AMOUNT",
            amount_money: { amount: 500, currency: "USD" },
          },
        },
      ])
    );

    const res = await handler({ queryStringParameters: { code: "5OFF", subtotal: "5000" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.discount).toBe(500);
    expect(body.catalogObjectId).toBe("DISC2");
  });

  it("rejects deleted discount objects", async () => {
    mockFetch.mockResolvedValueOnce(
      squareCatalogResponse([
        {
          type: "DISCOUNT",
          id: "DISC3",
          is_deleted: true,
          discount_data: {
            name: "DEAD",
            discount_type: "FIXED_PERCENTAGE",
            percentage: "20.0",
          },
        },
      ])
    );
    const res = await handler({ queryStringParameters: { code: "DEAD", subtotal: "5000" } });
    expect(res.statusCode).toBe(404);
  });
});
