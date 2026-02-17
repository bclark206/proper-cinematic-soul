/**
 * Serverless function: POST /api/create-order
 *
 * Creates an order via Square Orders API, then processes payment
 * via Square Payments API.
 *
 * Environment variables required:
 *   SQUARE_ACCESS_TOKEN — Square production access token
 *   SQUARE_LOCATION_ID  — Square location ID (LPPWSSV03BHK8)
 *
 * Request body:
 * {
 *   items: [{
 *     variationId: string,
 *     quantity: number,
 *     modifiers: [{ modifierId: string }],
 *     note?: string,
 *   }],
 *   customer: { name: string, phone: string, email: string },
 *   tip: number, // in cents
 *   sourceId: string, // payment nonce from Square Web Payments SDK
 *   pickupTime?: string, // ISO date string or "asap"
 * }
 *
 * Response:
 * {
 *   orderId: string,
 *   paymentId: string,
 *   confirmationNumber: string,
 * }
 *
 * Deployment: This can be deployed as a Netlify function, Vercel serverless
 * function, or Cloudflare Worker. Adjust the handler signature as needed.
 */

interface OrderItem {
  variationId: string;
  quantity: number;
  modifiers: { modifierId: string }[];
  note?: string;
}

interface CreateOrderRequest {
  items: OrderItem[];
  customer: { name: string; phone: string; email: string };
  tip: number;
  sourceId: string;
  pickupTime?: string;
}

// Generic handler — adapt exports for your platform (Netlify, Vercel, etc.)
export async function handler(event: { body: string }) {
  const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
  const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || "LPPWSSV03BHK8";

  if (!SQUARE_ACCESS_TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server misconfigured — missing Square credentials" }),
    };
  }

  let body: CreateOrderRequest;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const { items, customer, tip, sourceId, pickupTime } = body;

  if (!items?.length || !customer?.name || !sourceId) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing required fields" }),
    };
  }

  const idempotencyKey = crypto.randomUUID();

  // Step 1: Create Order via Square Orders API
  const lineItems = items.map((item) => ({
    catalog_object_id: item.variationId,
    quantity: String(item.quantity),
    modifiers: item.modifiers.map((m) => ({
      catalog_object_id: m.modifierId,
    })),
    ...(item.note ? { note: item.note } : {}),
  }));

  const orderPayload = {
    idempotency_key: idempotencyKey,
    order: {
      location_id: SQUARE_LOCATION_ID,
      line_items: lineItems,
      fulfillments: [
        {
          type: "PICKUP",
          state: "PROPOSED",
          pickup_details: {
            recipient: {
              display_name: customer.name,
              phone_number: customer.phone,
              email_address: customer.email,
            },
            ...(pickupTime && pickupTime !== "asap"
              ? { pickup_at: pickupTime }
              : { prep_time_duration: "P0DT0H30M0S" }),
          },
        },
      ],
      ...(tip > 0
        ? {
            service_charges: [
              {
                name: "Tip",
                amount_money: { amount: tip, currency: "USD" },
                calculation_phase: "SUBTOTAL_PHASE",
              },
            ],
          }
        : {}),
    },
  };

  try {
    const orderRes = await fetch("https://connect.squareup.com/v2/orders", {
      method: "POST",
      headers: {
        "Square-Version": "2024-01-18",
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(orderPayload),
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      console.error("Square Orders API error:", JSON.stringify(orderData));
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to create order", details: orderData }),
      };
    }

    const orderId = orderData.order.id;
    const totalMoney = orderData.order.total_money;

    // Step 2: Process Payment via Square Payments API
    const paymentPayload = {
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      amount_money: totalMoney,
      order_id: orderId,
      location_id: SQUARE_LOCATION_ID,
    };

    const paymentRes = await fetch("https://connect.squareup.com/v2/payments", {
      method: "POST",
      headers: {
        "Square-Version": "2024-01-18",
        Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(paymentPayload),
    });

    const paymentData = await paymentRes.json();

    if (!paymentRes.ok) {
      console.error("Square Payments API error:", JSON.stringify(paymentData));
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Failed to process payment", details: paymentData }),
      };
    }

    const confirmationNumber = `PC-${orderId.slice(-8).toUpperCase()}`;

    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId,
        paymentId: paymentData.payment.id,
        confirmationNumber,
      }),
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
}
