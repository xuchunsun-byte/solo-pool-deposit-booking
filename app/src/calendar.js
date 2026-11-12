import { formatInZone } from "./slots.js";

function icsStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < bytes.length) {
    const chunk = bytes.subarray(i, i + (i === 0 ? 75 : 74));
    parts.push(chunk.toString("utf8"));
    i += chunk.length;
  }
  return parts.join("\r\n ");
}

function icsText(s) {
  return String(s || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}

export function buildIcs({ booking, tech }) {
  const uid = `${booking.ics_token}@solo-pool-deposit-booking`;
  const summary = `${tech.service_name || "Pool service"} — ${tech.business_name || "Pool tech"}`;
  const description = [
    `Customer: ${booking.customer_name} (${booking.customer_email})`,
    booking.customer_phone ? `Phone: ${booking.customer_phone}` : "",
    booking.notes ? `Notes: ${booking.notes}` : "",
    tech.service_area ? `Service area: ${tech.service_area}` : "",
    "",
    "Deposit, if collected, goes to the technician's own Stripe account. We do not hold or escrow funds.",
  ]
    .filter(Boolean)
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Solo Pool Deposit Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(booking.start_at)}`,
    `DTEND:${icsStamp(booking.end_at)}`,
    fold(`SUMMARY:${icsText(summary)}`),
    fold(`DESCRIPTION:${icsText(description)}`),
    tech.service_area ? fold(`LOCATION:${icsText(tech.service_area)}`) : null,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].filter((l) => l !== null);
  return lines.join("\r\n");
}

export function googleCalendarTemplateUrl({ booking, tech }) {
  const text = `${tech.service_name || "Pool service"} — ${tech.business_name || "Pool tech"}`;
  const details = [
    `Customer: ${booking.customer_name}`,
    booking.notes || "",
    tech.cancel_policy ? `Cancel policy: ${tech.cancel_policy}` : "",
    "Deposits go to the technician's Stripe — we do not hold funds.",
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text,
    dates: `${icsStamp(booking.start_at)}/${icsStamp(booking.end_at)}`,
    details,
  });
  if (tech.service_area) params.set("location", tech.service_area);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function whenLabel(booking, tech) {
  return `${formatInZone(booking.start_at, tech.timezone || "America/New_York")} – ${formatInZone(
    booking.end_at,
    tech.timezone || "America/New_York",
    { weekday: undefined, month: undefined, day: undefined, year: undefined }
  )} (${tech.timezone || "America/New_York"})`;
}

export function googleOAuthConfigured(cfg) {
  return Boolean(cfg.googleClientId && cfg.googleClientSecret);
}
