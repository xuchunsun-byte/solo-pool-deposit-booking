import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { APP_ROOT } from "./env.js";

let nodemailerPromise;

async function getNodemailer() {
  if (!nodemailerPromise) nodemailerPromise = import("nodemailer");
  return nodemailerPromise;
}

export function mailLogPath(root = APP_ROOT) {
  return `${root}/data/mail.log`;
}

function logLocally(message, root) {
  const path = mailLogPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const entry = {
    at: new Date().toISOString(),
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html || null,
    loggedOnly: true,
  };
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  console.log(`[mail:log] to=${message.to} subject=${message.subject}`);
  if (message.text) {
    const link = message.text.match(/https?:\/\/\S+/g);
    if (link) console.log(`[mail:log] links: ${link.join(" ")}`);
  }
}

export function emailConfigured(cfg) {
  return Boolean(cfg.resendApiKey || cfg.smtp.host);
}

export async function sendEmail(cfg, message) {
  const from = cfg.emailFrom || "Solo Pool Deposit Booking <noreply@localhost>";
  const payload = { from, ...message };

  if (cfg.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: payload.from,
        to: [payload.to],
        subject: payload.subject,
        text: payload.text,
        html: payload.html || undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend ${res.status}: ${body}`);
    }
    logLocally({ ...payload, loggedOnly: false }, APP_ROOT);
    return { ok: true, provider: "resend" };
  }

  if (cfg.smtp.host) {
    const nodemailer = await getNodemailer();
    const transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    });
    await transporter.sendMail(payload);
    logLocally({ ...payload, loggedOnly: false }, APP_ROOT);
    return { ok: true, provider: "smtp" };
  }

  logLocally(payload, APP_ROOT);
  return { ok: false, provider: "log", reason: "no email provider configured" };
}

export function accessEmail({ accessLink }) {
  const subject = "Your Solo Pool Deposit Booking access";
  const text = `Thanks for subscribing. Your $29/mo plan is active.

Next steps (about 10 minutes):
1) Open your admin link: ${accessLink}
2) Set your business name, service, duration, service area, and open hours
3) Set your deposit amount (fixed $ or %) and cancel policy
4) Optional: paste your own Stripe Payment Link / Checkout URL so customers can pay the deposit to you — we never hold customer funds
5) Copy your public booking link into texts / Google Business Profile

This is a deposit booking page + calendar + email reminders — not Jobber, not lead gen.

Google Calendar sync via OAuth can be connected later. For now, every booking still gives you an ICS file and a Google Calendar template link.

Questions about setup: reply to this email with a screenshot of the step that failed.
`;
  const html = `<p>Thanks for subscribing. Your $29/mo plan is active.</p>
<p>Next steps (about 10 minutes):</p>
<ol>
  <li>Open your admin link: <a href="${accessLink}">${accessLink}</a></li>
  <li>Set your business name, service, duration, service area, and open hours</li>
  <li>Set your deposit amount (fixed $ or %) and cancel policy</li>
  <li>Optional: paste your own Stripe Payment Link / Checkout URL so customers can pay the deposit to you — we never hold customer funds</li>
  <li>Copy your public booking link into texts / Google Business Profile</li>
</ol>
<p>This is a deposit booking page + calendar + email reminders — not Jobber, not lead gen.</p>
<p>Google Calendar sync via OAuth can be connected later. For now, every booking still gives you an ICS file and a Google Calendar template link.</p>
<p>Questions about setup: reply to this email with a screenshot of the step that failed.</p>`;
  return { subject, text, html };
}

export function bookingConfirmationEmail({
  customerName,
  businessName,
  serviceName,
  whenLabel,
  serviceArea,
  cancelPolicy,
  icsUrl,
  gcalUrl,
  depositNote,
}) {
  const who = businessName || "your pool technician";
  const subject = `Booking confirmed with ${who}`;
  const text = `Hi ${customerName || "there"},

Your booking is confirmed.

Service: ${serviceName}
When: ${whenLabel}
Service area: ${serviceArea || "See notes from your technician"}

${depositNote}

Add to your calendar:
- ICS file: ${icsUrl}
- Google Calendar: ${gcalUrl}

Cancel / reschedule policy:
${cancelPolicy}

You'll get another email about 24 hours before the appointment.

This confirmation was sent by Solo Pool Deposit Booking on behalf of ${who}. Customer deposits (if collected) go to the technician's own Stripe account — we do not hold or escrow funds.
`;
  const html = `<p>Hi ${escapeHtml(customerName || "there")},</p>
<p>Your booking is confirmed.</p>
<p><strong>Service:</strong> ${escapeHtml(serviceName)}<br>
<strong>When:</strong> ${escapeHtml(whenLabel)}<br>
<strong>Service area:</strong> ${escapeHtml(serviceArea || "See notes from your technician")}</p>
<p>${escapeHtml(depositNote)}</p>
<p>Add to your calendar:</p>
<ul>
  <li><a href="${icsUrl}">Download ICS</a></li>
  <li><a href="${gcalUrl}">Add to Google Calendar</a></li>
</ul>
<p><strong>Cancel / reschedule policy</strong></p>
<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(cancelPolicy || "")}</pre>
<p>You'll get another email about 24 hours before the appointment.</p>
<p>This confirmation was sent by Solo Pool Deposit Booking on behalf of ${escapeHtml(who)}. Customer deposits (if collected) go to the technician's own Stripe account — we do not hold or escrow funds.</p>`;
  return { subject, text, html };
}

export function reminderEmail({
  customerName,
  businessName,
  serviceName,
  whenLabel,
  serviceArea,
  cancelPolicy,
}) {
  const who = businessName || "your pool technician";
  const subject = `Reminder: ${serviceName} tomorrow with ${who}`;
  const text = `Hi ${customerName || "there"},

This is a reminder that your appointment is coming up in about 24 hours.

Service: ${serviceName}
When: ${whenLabel}
Service area: ${serviceArea || "See notes from your technician"}

Cancel / reschedule policy:
${cancelPolicy}

See you then.
${who}
`;
  const html = `<p>Hi ${escapeHtml(customerName || "there")},</p>
<p>This is a reminder that your appointment is coming up in about 24 hours.</p>
<p><strong>Service:</strong> ${escapeHtml(serviceName)}<br>
<strong>When:</strong> ${escapeHtml(whenLabel)}<br>
<strong>Service area:</strong> ${escapeHtml(serviceArea || "See notes from your technician")}</p>
<p><strong>Cancel / reschedule policy</strong></p>
<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(cancelPolicy || "")}</pre>
<p>See you then.<br>${escapeHtml(who)}</p>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
