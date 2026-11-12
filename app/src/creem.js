import { createHmac, timingSafeEqual } from "node:crypto";

const GRANT_EVENTS = new Set([
  "checkout.completed",
  "subscription.paid",
  "subscription.active",
]);

const REVOKE_EVENTS = new Set([
  "subscription.canceled",
  "subscription.expired",
  "subscription.unpaid",
]);

export function verifyCreemSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return { ok: false, status: 500, error: "webhook secret not configured" };
  }
  if (!signatureHeader) {
    return { ok: false, status: 401, error: "missing signature" };
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const received = String(signatureHeader).trim();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "invalid signature" };
  }
  return { ok: true };
}

export function signCreemPayload(rawBody, secret) {
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function eventTypeOf(event) {
  return event?.eventType || event?.event_type || event?.type || "";
}

export function eventIdOf(event) {
  return event?.id || null;
}

export function payloadObject(event) {
  return event?.object || event?.data || event || {};
}

export function extractCustomer(event) {
  const obj = payloadObject(event);
  const customer = obj.customer && typeof obj.customer === "object" ? obj.customer : null;
  const email = customer?.email || obj.email || event?.customer?.email;
  const name = customer?.name || obj.name || null;
  const id = customer?.id || (typeof obj.customer === "string" ? obj.customer : null);
  return { email: email ? String(email).trim().toLowerCase() : "", name, id };
}

export function extractProductId(event) {
  const obj = payloadObject(event);
  const product = obj.product ?? obj.order?.product;
  if (typeof product === "string") return product;
  if (product && typeof product === "object") return product.id || null;
  return null;
}

export function extractSubscriptionId(event) {
  const obj = payloadObject(event);
  if (obj.object === "subscription" && obj.id) return obj.id;
  const sub = obj.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object") return sub.id || null;
  return null;
}

export function classifyEvent(event, expectedProductId) {
  const type = eventTypeOf(event);
  const productId = extractProductId(event);
  const customer = extractCustomer(event);
  const subscriptionId = extractSubscriptionId(event);
  const productOk = !expectedProductId || !productId || productId === expectedProductId;
  let action = "ignore";
  if (GRANT_EVENTS.has(type)) action = "grant";
  else if (REVOKE_EVENTS.has(type)) action = "revoke";
  return { type, productId, productOk, customer, subscriptionId, action };
}
