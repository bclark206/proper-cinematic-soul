/**
 * Serverless function: GET /api/validate-promo?code=XXX&subtotal=5000
 *
 * Validates a discount code against Square Catalog DISCOUNT objects.
 * Code matches Square discount `name` (case-insensitive).
 *
 * Response 200:
 *   { code, description, discount (cents), catalogObjectId, type, percentage?, amount? }
 * Response 404: code not found
 * Response 400: missing code
 *
 * Environment variables:
 *   SQUARE_ACCESS_TOKEN — Square production access token
 */

interface SquareDiscount {
  type: string;
  id: string;
  is_deleted?: boolean;
  discount_data?: {
    name?: string;
    discount_type?: string;
    percentage?: string;
    amount_money?: { amount?: number; currency?: string };
    pin_required?: boolean;
    label_color?: string;
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
};

export async function handler(event: { queryStringParameters?: Record<string, string | undefined> }) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Server misconfigured — missing Square credentials" }),
    };
  }

  const rawCode = event.queryStringParameters?.code;
  const subtotalRaw = event.queryStringParameters?.subtotal;
  if (!rawCode) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Missing code" }),
    };
  }

  const code = rawCode.trim().toUpperCase();
  const subtotal = Math.max(0, Math.floor(Number(subtotalRaw) || 0));

  // Fetch all DISCOUNT catalog objects (paginated).
  let allObjects: SquareDiscount[] = [];
  let cursor: string | undefined;
  try {
    do {
      const url = new URL("https://connect.squareup.com/v2/catalog/list");
      url.searchParams.set("types", "DISCOUNT");
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
        console.error("Square Catalog DISCOUNT fetch error:", JSON.stringify(err));
        return {
          statusCode: 502,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "Failed to fetch discounts" }),
        };
      }
      const data = await res.json();
      if (data.objects) allObjects = allObjects.concat(data.objects);
      cursor = data.cursor;
    } while (cursor);
  } catch (err) {
    console.error("Unexpected error fetching discounts:", err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }

  // Find a non-deleted DISCOUNT whose name matches the code (case-insensitive).
  const match = allObjects.find((obj) => {
    if (obj.type !== "DISCOUNT") return false;
    if (obj.is_deleted) return false;
    const name = (obj.discount_data?.name || "").trim().toUpperCase();
    return name === code;
  });

  if (!match || !match.discount_data) {
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Invalid promo code" }),
    };
  }

  const d = match.discount_data;
  let discount = 0;
  let description = "";

  switch (d.discount_type) {
    case "FIXED_PERCENTAGE":
    case "VARIABLE_PERCENTAGE": {
      const pct = parseFloat(d.percentage || "0");
      discount = Math.floor((subtotal * pct) / 100);
      description = `${pct}% off`;
      break;
    }
    case "FIXED_AMOUNT":
    case "VARIABLE_AMOUNT": {
      discount = d.amount_money?.amount || 0;
      description = `$${(discount / 100).toFixed(2)} off`;
      break;
    }
    default:
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "Discount type not supported online" }),
      };
  }

  // Cap discount at subtotal so we never go negative.
  if (discount > subtotal) discount = subtotal;

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      code: (d.name || code).toUpperCase(),
      description,
      discount,
      catalogObjectId: match.id,
      type: d.discount_type,
      percentage: d.percentage,
      amount: d.amount_money?.amount,
    }),
  };
}

// Vercel adapter
export default async function vercelHandler(
  req: { method?: string; query?: Record<string, string | string[] | undefined>; url?: string },
  res: {
    status: (code: number) => { send: (body: string) => void };
    setHeader: (k: string, v: string) => void;
  }
) {
  const queryStringParameters: Record<string, string | undefined> = {};
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (Array.isArray(v)) queryStringParameters[k] = v[0];
      else if (typeof v === "string") queryStringParameters[k] = v;
    }
  }
  const result = await handler({ queryStringParameters });
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, String(v));
  }
  res.status(result.statusCode).send(result.body);
}
