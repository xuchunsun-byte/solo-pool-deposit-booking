/**
 * Local fulfillment checks. Does not call Creem, Stripe, or charge anyone.
 * Uses a temp SQLite file and a synthetic webhook signed with a test secret.
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "spdb-"));
const dbPath = join(dir, "app.db");
const testSecret = "test_webhook_secret_not_live";
const port = await getPort();
const appUrl = `http://127.0.0.1:${port}`;

process.env.NODE_ENV = "test";
process.env.PORT = String(port);
process.env.APP_URL = appUrl;
process.env.SESSION_SECRET = "test-session-secret";
process.env.DATABASE_PATH = dbPath;
process.env.CREEM_WEBHOOK_SECRET = testSecret;
process.env.CREEM_PRODUCT_ID = "prod_JyQlU86FhnSLYstg4Eaie";
process.env.ALLOW_DEV_GRANT = "true";
process.env.EMAIL_FROM = "test@localhost";
// No Resend/SMTP — mailer must log to data/mail.log

const { createApp } = await import("../src/server.js");
const { signCreemPayload } = await import("../src/creem.js");
const { APP_ROOT } = await import("../src/env.js");
const { config } = await import("../src/env.js");

const cfg = {
  ...config(),
  nodeEnv: "test",
  isProd: false,
  port,
  appUrl,
  sessionSecret: "test-session-secret",
  databasePath: dbPath,
  creemWebhookSecret: testSecret,
  creemProductId: "prod_JyQlU86FhnSLYstg4Eaie",
  allowDevGrant: true,
  emailFrom: "test@localhost",
  resendApiKey: "",
  smtp: { host: "", port: 587, user: "", pass: "", secure: false },
  cronSecret: "",
};

const app = createApp(cfg);
const server = createServer(app);
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures.push(`${name}${detail ? ": " + detail : ""}`);
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};

try {
  console.log("Solo Pool Deposit Booking — local verify");
  console.log(`  temp db: ${dbPath}`);
  console.log(`  server:  ${appUrl}`);

  const health = await fetchJson(`${appUrl}/healthz`);
  ok("healthz", health.ok === true && health.webhookSecretConfigured === true);

  const thanks = await fetch(`${appUrl}/thanks?session=ch_test&checkout=abc`);
  const thanksHtml = await thanks.text();
  ok("thanks page 200 with query params", thanks.status === 200 && /Thanks for subscribing/i.test(thanksHtml));

  const cancelled = await fetch(`${appUrl}/cancelled?session=xyz`);
  ok("cancelled page 200 with query params", cancelled.status === 200 && /not charged/i.test(await cancelled.text()));

  const unsigned = await fetch(`${appUrl}/webhooks/creem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventType: "checkout.completed" }),
  });
  ok("webhook rejects missing signature", unsigned.status === 401);

  const bad = await fetch(`${appUrl}/webhooks/creem`, {
    method: "POST",
    headers: { "content-type": "application/json", "creem-signature": "deadbeef" },
    body: JSON.stringify({ eventType: "checkout.completed" }),
  });
  ok("webhook rejects bad signature", bad.status === 401);

  const payload = JSON.stringify({
    id: "evt_verify_1",
    eventType: "checkout.completed",
    object: {
      id: "ch_verify_1",
      object: "checkout",
      status: "completed",
      product: { id: "prod_JyQlU86FhnSLYstg4Eaie", name: "Solo Pool Deposit Booking" },
      customer: { id: "cust_verify", email: "tech.demo@example.com", name: "Demo Tech" },
      subscription: { id: "sub_verify", status: "active" },
    },
  });
  const sig = signCreemPayload(payload, testSecret);
  const granted = await fetch(`${appUrl}/webhooks/creem`, {
    method: "POST",
    headers: { "content-type": "application/json", "creem-signature": sig },
    body: payload,
  });
  const grantedBody = await granted.json().catch(() => ({}));
  ok("signed checkout.completed accepted", granted.status === 200 && grantedBody.received === true, JSON.stringify(grantedBody));

  const replay = await fetch(`${appUrl}/webhooks/creem`, {
    method: "POST",
    headers: { "content-type": "application/json", "creem-signature": sig },
    body: payload,
  });
  ok("replay is idempotent 200", replay.status === 200);

  const mailbox = readMailbox();
  ok("access email logged after grant", /Your Solo Pool Deposit Booking access/.test(mailbox) && /tech\.demo@example.com/.test(mailbox));
  const magic = (mailbox.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/magic\?token=[a-f0-9]+/) || [])[0];
  ok("magic link present in access email", Boolean(magic), mailbox.slice(-500));

  const magicRes = await fetch(magic, { redirect: "manual" });
  const setCookie = magicRes.headers.get("set-cookie") || "";
  ok("magic link sets session and redirects to admin", magicRes.status === 302 && /\/admin/.test(magicRes.headers.get("location") || "") && /spdb_session=/.test(setCookie));
  const cookie = setCookie.split(";")[0];

  const adminGet = await fetch(`${appUrl}/admin`, { headers: { cookie } });
  const adminHtml = await adminGet.text();
  ok("admin loads for paid tech", adminGet.status === 200 && /Business &amp; service|Business & service/.test(adminHtml));

  const form = new URLSearchParams({
    business_name: "Desert Pool Co",
    slug: "desert-pool-co",
    service_name: "Pool opening",
    duration_minutes: "120",
    service_area: "North Phoenix",
    timezone: "America/Phoenix",
    deposit_type: "fixed",
    deposit_amount: "75",
    cancel_policy: "Cancel 24 hours ahead for a refund issued by the technician on their own Stripe.",
    hours_mon_on: "on",
    hours_mon_start: "08:00",
    hours_mon_end: "17:00",
    hours_tue_on: "on",
    hours_tue_start: "08:00",
    hours_tue_end: "17:00",
    hours_wed_on: "on",
    hours_wed_start: "08:00",
    hours_wed_end: "17:00",
    hours_thu_on: "on",
    hours_thu_start: "08:00",
    hours_thu_end: "17:00",
    hours_fri_on: "on",
    hours_fri_start: "08:00",
    hours_fri_end: "17:00",
    hours_sat_start: "08:00",
    hours_sat_end: "14:00",
    hours_sun_start: "08:00",
    hours_sun_end: "14:00",
  });
  const saved = await fetch(`${appUrl}/admin`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  ok("admin settings save", saved.status === 302 && /saved=1/.test(saved.headers.get("location") || ""));

  const bookingPage = await fetch(`${appUrl}/b/desert-pool-co`);
  const bookingHtml = await bookingPage.text();
  ok("public booking page opens", bookingPage.status === 200 && /Pool opening/.test(bookingHtml) && /Deposit not configured/.test(bookingHtml));
  ok("booking page has at least one slot", /<option value="[^"]+\|/.test(bookingHtml));
  const slotValue = (bookingHtml.match(/<option value="([^"]+\|[^"]+)"/) || [])[1];

  const booked = await fetch(`${appUrl}/b/desert-pool-co`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      slot: slotValue,
      customer_name: "Alex Homeowner",
      customer_email: "alex.homeowner@example.com",
      customer_phone: "555-0100",
      notes: "Green-to-clean, gate code 12",
    }).toString(),
  });
  const doneHtml = await booked.text();
  ok("booking confirmation page", booked.status === 200 && /You’re booked|You.re booked/.test(doneHtml));
  const icsPath = (doneHtml.match(/href="([^"]+\.ics)"/) || [])[1];
  ok("ICS link on confirmation", Boolean(icsPath), doneHtml.slice(0, 400));

  const icsRes = await fetch(icsPath);
  const ics = await icsRes.text();
  ok("ICS download", icsRes.status === 200 && /BEGIN:VEVENT/.test(ics) && /Alex Homeowner/.test(ics));

  const mail2 = readMailbox();
  ok("customer confirmation email logged", /Booking confirmed with Desert Pool Co/.test(mail2) && /alex\.homeowner@example.com/.test(mail2));

  const cancelPayload = JSON.stringify({
    id: "evt_verify_cancel",
    eventType: "subscription.canceled",
    object: {
      id: "sub_verify",
      object: "subscription",
      status: "canceled",
      product: { id: "prod_JyQlU86FhnSLYstg4Eaie" },
      customer: { id: "cust_verify", email: "tech.demo@example.com" },
    },
  });
  const cancelRes = await fetch(`${appUrl}/webhooks/creem`, {
    method: "POST",
    headers: { "content-type": "application/json", "creem-signature": signCreemPayload(cancelPayload, testSecret) },
    body: cancelPayload,
  });
  ok("subscription.canceled accepted", cancelRes.status === 200);
  const gone = await fetch(`${appUrl}/b/desert-pool-co`);
  ok("public page hidden after cancel", gone.status === 404);

  const cron = await fetch(`${appUrl}/internal/cron/reminders`, { method: "POST" });
  const cronBody = await cron.json();
  ok("reminder cron endpoint", cron.status === 200 && cronBody.ok === true);

  // Confirm no checkout URL leaked onto these pages
  ok("admin/booking pages do not include Creem checkout URL", !adminHtml.includes("prod_JyQlU86FhnSLYstg4Eaie") && !bookingHtml.includes("prod_JyQlU86FhnSLYstg4Eaie"));

  if (failures.length) {
    console.error(`\n${failures.length} failed:\n - ${failures.join("\n - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed. No live charges were made.");
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}

function readMailbox() {
  const path = join(APP_ROOT, "data", "mail.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

function getPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

void pathToFileURL;
