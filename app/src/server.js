import express from "express";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, config as loadConfig, APP_ROOT } from "./env.js";
import {
  openDb,
  getTechById,
  getTechByEmail,
  getTechBySlug,
  upsertTechByEmail,
  markAccessEmailSent,
  slugTaken,
  insertWebhookEvent,
  insertBooking,
  getBookingByIcsToken,
  listBookingsForTech,
  slotTaken,
  markConfirmationSent,
  parseHours,
  DEFAULT_CANCEL_POLICY,
  DEFAULT_SERVICE,
  normEmail,
} from "./db.js";
import {
  verifyCreemSignature,
  eventIdOf,
  eventTypeOf,
  classifyEvent,
} from "./creem.js";
import {
  sendEmail,
  emailConfigured,
  accessEmail,
  bookingConfirmationEmail,
} from "./mailer.js";
import {
  createMagicToken,
  redeemMagicToken,
  createSession,
  sessionCookie,
  clearSessionCookie,
  currentTech,
  logout,
  magicUrl,
} from "./auth.js";
import { openSlots, isSlotOffered, formatInZone } from "./slots.js";
import { buildIcs, googleCalendarTemplateUrl, whenLabel, googleOAuthConfigured } from "./calendar.js";
import { processReminders, startReminderLoop } from "./reminders.js";
import { render, escapeHtml } from "./views.js";

loadEnv();

export function createApp(cfg = loadConfig()) {
  openDb(cfg.databasePath);
  const app = express();
  const secureCookie = cfg.appUrl.startsWith("https://");

  app.set("trust proxy", 1);

  app.post(
    "/webhooks/creem",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "", "utf8");
      const verified = verifyCreemSignature(raw, req.headers["creem-signature"], cfg.creemWebhookSecret);
      if (!verified.ok) {
        return res.status(verified.status).type("text/plain").send(verified.error);
      }
      let event;
      try {
        event = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).type("text/plain").send("invalid json");
      }
      const eventId = eventIdOf(event) || `anon-${Date.now()}`;
      const inserted = insertWebhookEvent(eventId, eventTypeOf(event), raw.toString("utf8"));
      try {
        if (inserted) await handleCreemEvent(cfg, event);
      } catch (err) {
        console.error("[creem webhook]", err);
        return res.status(500).type("text/plain").send("handler error");
      }
      return res.status(200).json({ received: true, event: eventTypeOf(event), id: eventId });
    }
  );

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.static(resolve(APP_ROOT, "public")));

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      app: "solo-pool-deposit-booking",
      emailConfigured: emailConfigured(cfg),
      webhookSecretConfigured: Boolean(cfg.creemWebhookSecret),
      googleOauthConfigured: googleOAuthConfigured(cfg),
    });
  });

  app.get("/", (req, res) => {
    const tech = currentTech(req);
    res.send(
      render("home.html", {
        title: "Solo Pool Deposit Booking",
        nav: navHtml(tech),
      })
    );
  });

  app.get("/thanks", (req, res) => {
    // Query params (session=, checkout=, etc.) are ignored and must not break the page.
    const tech = currentTech(req);
    res.send(
      render("thanks.html", {
        title: "Thanks for subscribing — Solo Pool Deposit Booking",
        nav: navHtml(tech),
        flash: "",
      })
    );
  });

  app.get("/cancelled", (req, res) => {
    const tech = currentTech(req);
    res.send(
      render("cancelled.html", {
        title: "Checkout canceled — Solo Pool Deposit Booking",
        nav: navHtml(tech),
      })
    );
  });

  app.get("/login", (req, res) => {
    const tech = currentTech(req);
    if (tech && tech.paid) return res.redirect("/admin");
    res.send(loginPage(tech, req.query.error, req.query.email));
  });

  app.post("/login", async (req, res) => {
    const email = normEmail(req.body?.email);
    if (!email || !email.includes("@")) {
      return res.status(400).send(loginPage(currentTech(req), "Enter a valid email.", email));
    }
    const tech = getTechByEmail(email);
    if (tech && tech.paid) {
      try {
        await sendAccessLink(cfg, tech, { force: true });
      } catch (err) {
        console.error("[login email]", err);
        return res
          .status(500)
          .send(loginPage(currentTech(req), "Could not send email just now. Try again in a minute.", email));
      }
    }
    // Same response whether or not the account exists / is paid — avoid leaking status.
    res.send(
      render("login-sent.html", {
        title: "Check your email — Solo Pool Deposit Booking",
        nav: navHtml(currentTech(req)),
        email,
      })
    );
  });

  app.get("/auth/magic", (req, res) => {
    const token = String(req.query.token || "");
    const tech = redeemMagicToken(token);
    if (!tech || !tech.paid) {
      return res
        .status(401)
        .send(loginPage(null, "That login link is invalid or has expired. Request a new one."));
    }
    const session = createSession(tech.id);
    res.setHeader("Set-Cookie", sessionCookie(session.token, { secure: secureCookie }));
    res.redirect("/admin");
  });

  app.post("/logout", (req, res) => {
    logout(req);
    res.setHeader("Set-Cookie", clearSessionCookie({ secure: secureCookie }));
    res.redirect("/login");
  });

  app.get("/admin", (req, res) => {
    const tech = requirePaid(req, res);
    if (!tech) return;
    res.send(adminPage(cfg, tech, req.query.saved ? "Settings saved." : ""));
  });

  app.post("/admin", (req, res) => {
    const tech = requirePaid(req, res);
    if (!tech) return;
    try {
      const updated = saveAdmin(tech, req.body);
      res.redirect("/admin?saved=1");
      void updated;
    } catch (err) {
      res.status(400).send(adminPage(cfg, getTechByEmail(tech.email), "", err.message));
    }
  });

  app.get("/b/:slug", (req, res) => {
    const tech = getTechBySlug(req.params.slug);
    if (!tech || !tech.paid) {
      return res.status(404).send(
        render("unavailable.html", {
          title: "Booking page unavailable",
          nav: navHtml(currentTech(req)),
          message: "This booking page is not active.",
        })
      );
    }
    res.send(bookingPage(cfg, tech, { error: req.query.error }));
  });

  app.post("/b/:slug", async (req, res) => {
    const tech = getTechBySlug(req.params.slug);
    if (!tech || !tech.paid) {
      return res.status(404).send(
        render("unavailable.html", {
          title: "Booking page unavailable",
          nav: "",
          message: "This booking page is not active.",
        })
      );
    }
    try {
      const booking = await createBooking(cfg, tech, req.body);
      const icsUrl = `${cfg.appUrl}/calendar/${booking.ics_token}.ics`;
      const gcalUrl = googleCalendarTemplateUrl({ booking, tech });
      const depositNote = depositNoteFor(tech);
      const stripeBlock = isStripeLink(tech.stripe_payment_link)
        ? `<p class="cta-row" style="margin-top:1rem"><a class="btn btn-primary" href="${escapeHtml(tech.stripe_payment_link)}">Pay your deposit on Stripe</a></p>
           <p class="cta-micro">You’ll complete payment on the technician’s Stripe page. We never see or store your card number.</p>`
        : `<p class="cta-micro">The technician has not pasted a Stripe payment link yet, so no deposit is collected here. We do not take card numbers.</p>`;
      res.send(
        render("booking-done.html", {
          title: "Booking confirmed — Solo Pool Deposit Booking",
          nav: "",
          tech,
          booking,
          when_label: whenLabel(booking, tech),
          deposit_note: depositNote,
          ics_url: icsUrl,
          gcal_url: gcalUrl,
          stripe_block: stripeBlock,
        })
      );
    } catch (err) {
      res.status(400).send(bookingPage(cfg, tech, { error: err.message }));
    }
  });

  app.get("/calendar/:token.ics", (req, res) => {
    const booking = getBookingByIcsToken(req.params.token);
    if (!booking) return res.status(404).type("text/plain").send("not found");
    const tech = (yieldTech(booking.tech_id));
    const ics = buildIcs({ booking, tech });
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="booking-${booking.id}.ics"`);
    res.send(ics);
  });

  app.post("/internal/cron/reminders", async (req, res) => {
    if (cfg.cronSecret) {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.secret || req.body?.secret;
      if (token !== cfg.cronSecret) return res.status(401).json({ ok: false, error: "unauthorized" });
    } else if (cfg.isProd) {
      return res.status(401).json({ ok: false, error: "CRON_SECRET required in production" });
    }
    const results = await processReminders(cfg);
    res.json({ ok: true, processed: results.length, results });
  });

  if (cfg.allowDevGrant && !cfg.isProd) {
    app.post("/dev/grant-access", async (req, res) => {
      const email = normEmail(req.body?.email);
      if (!email || !email.includes("@")) {
        return res.status(400).json({ ok: false, error: "email required" });
      }
      const tech = upsertTechByEmail(email, {
        name: req.body?.name || null,
        paid: 1,
        creem_product_id: cfg.creemProductId,
      });
      const sent = await sendAccessLink(cfg, tech, { force: true });
      res.json({
        ok: true,
        warning: "Dev grant only — not a real Creem charge.",
        email: tech.email,
        paid: true,
        emailResult: sent,
      });
    });

    app.get("/dev/mailbox", (_req, res) => {
      res.type("text/plain");
      const path = resolve(APP_ROOT, "data", "mail.log");
      if (!existsSync(path)) return res.send("(empty mailbox — data/mail.log not created yet)\n");
      res.send(readFileSync(path, "utf8"));
    });
  }

  return app;
}

function yieldTech(id) {
  return getTechById(id);
}

function requirePaid(req, res) {
  const tech = currentTech(req);
  if (!tech) {
    res.redirect("/login");
    return null;
  }
  if (!tech.paid) {
    res.status(403).send(
      loginPage(
        null,
        "This account does not have an active subscription, so admin is locked. If you just paid, wait for the access email or request a new login link."
      )
    );
    return null;
  }
  return tech;
}

async function handleCreemEvent(cfg, event) {
  const classified = classifyEvent(event, cfg.creemProductId);
  if (!classified.productOk) {
    console.log(`[creem] ignored event for other product ${classified.productId}`);
    return;
  }
  if (classified.action === "ignore") {
    console.log(`[creem] ignored event type ${classified.type}`);
    return;
  }
  const email = classified.customer.email;
  if (!email) {
    console.warn("[creem] event missing customer email", classified.type);
    return;
  }
  if (classified.action === "grant") {
    const tech = upsertTechByEmail(email, {
      name: classified.customer.name,
      paid: 1,
      creem_customer_id: classified.customer.id,
      creem_subscription_id: classified.subscriptionId,
      creem_product_id: classified.productId || cfg.creemProductId,
    });
    if (!tech.access_email_sent_at) {
      await sendAccessLink(cfg, tech, { force: false });
    }
    return;
  }
  if (classified.action === "revoke") {
    upsertTechByEmail(email, {
      name: classified.customer.name,
      paid: 0,
      creem_customer_id: classified.customer.id,
      creem_subscription_id: classified.subscriptionId,
      creem_product_id: classified.productId || cfg.creemProductId,
    });
  }
}

async function sendAccessLink(cfg, tech, { force } = {}) {
  const token = createMagicToken(tech.id);
  const link = magicUrl(cfg.appUrl, token);
  const msg = accessEmail({ accessLink: link });
  const result = await sendEmail(cfg, { to: tech.email, ...msg });
  if (!tech.access_email_sent_at || force) markAccessEmailSent(tech.id);
  return result;
}

function slugify(input) {
  const s = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length >= 3 ? s : "";
}

function uniqueSlug(base, exceptId) {
  let candidate = base || `tech-${randomBytes(3).toString("hex")}`;
  if (candidate.length < 3) candidate = `tech-${randomBytes(3).toString("hex")}`;
  let i = 0;
  while (slugTaken(candidate, exceptId)) {
    i += 1;
    candidate = `${base.slice(0, 32)}-${i}`;
  }
  return candidate;
}

function saveAdmin(tech, body) {
  const businessName = String(body.business_name || "").trim();
  if (!businessName) throw new Error("Business name is required.");
  let slug = slugify(body.slug || businessName);
  if (!slug) slug = uniqueSlug(`tech-${tech.id}`, tech.id);
  if (slugTaken(slug, tech.id)) throw new Error("That public URL slug is already taken.");
  const duration = Number(body.duration_minutes);
  if (!Number.isFinite(duration) || duration < 30) throw new Error("Duration must be at least 30 minutes.");
  const depositAmount = Number(body.deposit_amount);
  if (!Number.isFinite(depositAmount) || depositAmount < 0) throw new Error("Enter a valid deposit amount.");
  const depositType = body.deposit_type === "percent" ? "percent" : "fixed";
  const stripe = String(body.stripe_payment_link || "").trim();
  if (stripe && !isStripeLink(stripe)) {
    throw new Error("Deposit link must be an https Stripe Payment Link or Checkout URL.");
  }
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const hours = {};
  for (const day of days) {
    hours[day] = {
      enabled: body[`hours_${day}_on`] === "on" || body[`hours_${day}_on`] === "1",
      start: body[`hours_${day}_start`] || "08:00",
      end: body[`hours_${day}_end`] || "17:00",
    };
  }
  return upsertTechByEmail(tech.email, {
    business_name: businessName,
    slug,
    service_name: String(body.service_name || DEFAULT_SERVICE).trim() || DEFAULT_SERVICE,
    duration_minutes: duration,
    service_area: String(body.service_area || "").trim(),
    timezone: String(body.timezone || "America/New_York").trim() || "America/New_York",
    weekly_hours: JSON.stringify(hours),
    deposit_type: depositType,
    deposit_amount: depositAmount,
    cancel_policy: String(body.cancel_policy || DEFAULT_CANCEL_POLICY),
    stripe_payment_link: stripe || null,
    paid: tech.paid,
    creem_customer_id: tech.creem_customer_id,
    creem_subscription_id: tech.creem_subscription_id,
    creem_product_id: tech.creem_product_id,
    access_email_sent_at: tech.access_email_sent_at,
    name: tech.name,
  });
}

function isStripeLink(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "buy.stripe.com" ||
      host === "checkout.stripe.com" ||
      host.endsWith(".stripe.com")
    );
  } catch {
    return false;
  }
}

function depositNoteFor(tech) {
  const amount =
    tech.deposit_type === "percent"
      ? `${Number(tech.deposit_amount)}% deposit`
      : `$${Number(tech.deposit_amount).toFixed(0)} deposit`;
  if (isStripeLink(tech.stripe_payment_link)) {
    return `Please pay a ${amount} on the technician's own Stripe page. We never hold or escrow customer funds.`;
  }
  return `This technician asks for a ${amount}, but a Stripe payment link has not been configured yet. No card is collected on this page, and we do not hold funds.`;
}

async function createBooking(cfg, tech, body) {
  const name = String(body.customer_name || "").trim();
  const email = normEmail(body.customer_email);
  if (!name) throw new Error("Please enter your name.");
  if (!email || !email.includes("@")) throw new Error("Please enter a valid email.");
  const slotRaw = String(body.slot || "");
  const [start, end] = slotRaw.split("|");
  if (!start || !end) throw new Error("Please pick an open slot.");
  const booked = listBookingsForTech(tech.id);
  if (slotTaken(tech.id, start, end) || !isSlotOffered(tech, start, end, booked)) {
    throw new Error("That slot is no longer available. Please pick another time.");
  }
  const startMs = new Date(start).getTime();
  const reminderDue =
    startMs - 24 * 3600 * 1000 > Date.now()
      ? new Date(startMs - 24 * 3600 * 1000).toISOString()
      : null;
  const booking = insertBooking({
    tech_id: tech.id,
    customer_name: name,
    customer_email: email,
    customer_phone: String(body.customer_phone || "").trim(),
    notes: String(body.notes || "").trim(),
    start_at: start,
    end_at: end,
    status: "confirmed",
    ics_token: randomBytes(16).toString("hex"),
    reminder_due_at: reminderDue,
  });
  const icsUrl = `${cfg.appUrl}/calendar/${booking.ics_token}.ics`;
  const gcalUrl = googleCalendarTemplateUrl({ booking, tech });
  const msg = bookingConfirmationEmail({
    customerName: name,
    businessName: tech.business_name,
    serviceName: tech.service_name,
    whenLabel: whenLabel(booking, tech),
    serviceArea: tech.service_area,
    cancelPolicy: tech.cancel_policy,
    icsUrl,
    gcalUrl,
    depositNote: depositNoteFor(tech),
  });
  try {
    await sendEmail(cfg, { to: email, ...msg });
    if (tech.email) {
      await sendEmail(cfg, {
        to: tech.email,
        subject: `New booking: ${tech.service_name} with ${name}`,
        text: `${name} (${email}) booked ${tech.service_name} at ${whenLabel(booking, tech)}.\n\nICS: ${icsUrl}\nGoogle Calendar: ${gcalUrl}\n`,
      });
    }
    markConfirmationSent(booking.id);
  } catch (err) {
    console.error("[booking email]", err);
    // Booking still stands; emails are also in data/mail.log when no provider is set.
  }
  return booking;
}

function navHtml(tech) {
  if (tech && tech.paid) {
    return `<a href="/admin">Admin</a>
      ${tech.slug ? `<a href="/b/${escapeHtml(tech.slug)}">Public page</a>` : ""}
      <form method="post" action="/logout" style="display:inline"><button class="btn btn-secondary" type="submit">Log out</button></form>`;
  }
  return `<a href="/login">Log in</a><a class="btn btn-primary" href="/thanks">Just paid?</a>`;
}

function flashHtml(message, kind = "ok") {
  if (!message) return "";
  return `<div class="flash flash-${kind}" role="status">${escapeHtml(message)}</div>`;
}

function loginPage(tech, error, email = "") {
  return render("login.html", {
    title: "Log in — Solo Pool Deposit Booking",
    nav: navHtml(tech),
    email: email || "",
    flash: error ? flashHtml(error, "error") : "",
  });
}

function adminPage(cfg, tech, savedMessage, error) {
  const hours = parseHours(tech.weekly_hours);
  const labels = {
    mon: "Mon",
    tue: "Tue",
    wed: "Wed",
    thu: "Thu",
    fri: "Fri",
    sat: "Sat",
    sun: "Sun",
  };
  const hoursFields = `<div class="hours-grid">${Object.entries(labels)
    .map(([key, label]) => {
      const row = hours[key] || { enabled: false, start: "08:00", end: "17:00" };
      const checked = row.enabled ? "checked" : "";
      return `<div class="hours-row">
        <span>${label}</span>
        <input type="checkbox" name="hours_${key}_on" ${checked} aria-label="${label} open" />
        <input type="time" name="hours_${key}_start" value="${escapeHtml(row.start)}" aria-label="${label} start" />
        <input class="end-time" type="time" name="hours_${key}_end" value="${escapeHtml(row.end)}" aria-label="${label} end" />
      </div>`;
    })
    .join("")}</div>`;
  const bookings = listBookingsForTech(tech.id);
  const upcoming = bookings.filter((b) => new Date(b.end_at).getTime() >= Date.now() - 3600_000);
  const bookingsTable = upcoming.length
    ? `<table class="bookings-table"><thead><tr><th>When</th><th>Customer</th><th>Notes</th></tr></thead><tbody>${upcoming
        .map(
          (b) => `<tr>
            <td>${escapeHtml(formatInZone(b.start_at, tech.timezone || "America/New_York"))}</td>
            <td>${escapeHtml(b.customer_name)}<br><span class="hint">${escapeHtml(b.customer_email)}</span></td>
            <td>${escapeHtml(b.notes || "")}</td>
          </tr>`
        )
        .join("")}</tbody></table>`
    : `<p class="form-lead">No upcoming bookings yet.</p>`;
  const publicUrl = tech.slug ? `${cfg.appUrl}/b/${tech.slug}` : "";
  const publicLinkBlock = tech.slug
    ? `<div class="form-card" style="max-width:100%;margin-bottom:1.5rem">
        <h2>Your public booking link</h2>
        <p class="form-lead">Share this in texts or your Google Business Profile.</p>
        <p><a class="copy-url" href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>
      </div>`
    : `<p class="form-lead">Save a business name to get your public booking link.</p>`;
  const depositTypeOptions = ["fixed", "percent"]
    .map((t) => `<option value="${t}" ${tech.deposit_type === t ? "selected" : ""}>${t === "fixed" ? "Fixed dollars" : "Percent"}</option>`)
    .join("");
  return render("admin.html", {
    title: "Admin — Solo Pool Deposit Booking",
    nav: navHtml(tech),
    tech,
    paid_label: tech.paid ? "active ($29/mo)" : "inactive",
    business_suffix: tech.business_name ? ` — ${tech.business_name}` : "",
    flash: error ? flashHtml(error, "error") : savedMessage ? flashHtml(savedMessage, "ok") : "",
    public_link_block: publicLinkBlock,
    hours_fields: hoursFields,
    deposit_type_options: depositTypeOptions,
    bookings_table: bookingsTable,
  });
}

function bookingPage(cfg, tech, { error } = {}) {
  const slots = openSlots(tech, { days: 14, booked: listBookingsForTech(tech.id) });
  const slotOptions = slots.length
    ? slots
        .map((s) => `<option value="${escapeHtml(s.start + "|" + s.end)}">${escapeHtml(s.label)}</option>`)
        .join("")
    : `<option value="">No open slots in the next 2 weeks</option>`;
  const amount =
    tech.deposit_type === "percent"
      ? `${Number(tech.deposit_amount)}% deposit`
      : `$${Number(tech.deposit_amount).toFixed(0)} deposit`;
  const configured = isStripeLink(tech.stripe_payment_link);
  const depositBlock = configured
    ? `<div class="deposit-note"><strong>${escapeHtml(amount)}</strong> paid on this technician's Stripe. We never hold or escrow funds, and we never collect your card number on this page.</div>`
    : `<div class="deposit-note warn"><strong>Deposit not configured.</strong> This technician lists a ${escapeHtml(amount)}, but has not pasted a Stripe Payment Link yet. You can still request a slot. No card is collected here — we do not hold customer funds.</div>`;
  return render("booking.html", {
    title: `${tech.business_name || "Book a visit"} — Solo Pool Deposit Booking`,
    nav: "",
    tech,
    duration_label: `${tech.duration_minutes} minutes`,
    flash: error ? flashHtml(error, "error") : "",
    deposit_block: depositBlock,
    slot_options: slotOptions,
    submit_label: configured ? "Request slot & go to deposit" : "Request this slot",
  });
}

export function start(cfg = loadConfig()) {
  if (cfg.isProd && !cfg.sessionSecret) {
    throw new Error("SESSION_SECRET is required in production");
  }
  if (!cfg.sessionSecret) {
    console.warn("[warn] SESSION_SECRET is empty — set one before any public deploy");
  }
  const app = createApp(cfg);
  startReminderLoop(cfg);
  const server = app.listen(cfg.port, "0.0.0.0", () => {
    console.log(`Solo Pool Deposit Booking listening on ${cfg.appUrl} (port ${cfg.port})`);
    console.log(`  webhook: POST ${cfg.appUrl}/webhooks/creem`);
    console.log(`  thanks:  ${cfg.appUrl}/thanks`);
    console.log(`  email:   ${emailConfigured(cfg) ? "provider configured" : "LOG ONLY (data/mail.log) — set RESEND_API_KEY or SMTP_*"}`);
    console.log(`  webhook secret: ${cfg.creemWebhookSecret ? "set" : "MISSING — endpoint will return 500 until CREEM_WEBHOOK_SECRET is set"}`);
  });
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  start();
}
