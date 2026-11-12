import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_HOURS = {
  mon: { enabled: true, start: "08:00", end: "17:00" },
  tue: { enabled: true, start: "08:00", end: "17:00" },
  wed: { enabled: true, start: "08:00", end: "17:00" },
  thu: { enabled: true, start: "08:00", end: "17:00" },
  fri: { enabled: true, start: "08:00", end: "17:00" },
  sat: { enabled: true, start: "08:00", end: "14:00" },
  sun: { enabled: false, start: "08:00", end: "14:00" },
};

export const DEFAULT_CANCEL_POLICY = `Cancel or reschedule at least 24 hours before your appointment for a full deposit refund, issued by the technician through their own Stripe account. Cancellations inside 24 hours may forfeit the deposit, at the technician's discretion.

We do not hold or escrow your deposit — the technician is the merchant of record. This is a starting policy template; the technician is responsible for the final wording and any local legal requirements.`;

export const DEFAULT_SERVICE = "Pool opening / service visit";

let db;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS techs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      paid INTEGER NOT NULL DEFAULT 0,
      creem_customer_id TEXT,
      creem_subscription_id TEXT,
      creem_product_id TEXT,
      access_email_sent_at TEXT,
      business_name TEXT,
      service_name TEXT DEFAULT 'Pool opening / service visit',
      duration_minutes INTEGER DEFAULT 120,
      service_area TEXT,
      timezone TEXT DEFAULT 'America/New_York',
      weekly_hours TEXT,
      deposit_type TEXT DEFAULT 'fixed',
      deposit_amount REAL DEFAULT 50,
      cancel_policy TEXT,
      stripe_payment_link TEXT,
      slug TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tech_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tech_id) REFERENCES techs(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tech_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tech_id) REFERENCES techs(id)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tech_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      notes TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      ics_token TEXT NOT NULL UNIQUE,
      reminder_due_at TEXT,
      reminder_sent_at TEXT,
      confirmation_sent_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (tech_id) REFERENCES techs(id)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creem_event_id TEXT UNIQUE,
      event_type TEXT,
      payload TEXT,
      processed_at TEXT NOT NULL
    );
  `);
  return db;
}

export function getDb() {
  if (!db) throw new Error("database not opened");
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

export function defaultHoursJson() {
  return JSON.stringify(DEFAULT_HOURS);
}

export function parseHours(raw) {
  if (!raw) return { ...DEFAULT_HOURS };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_HOURS, ...parsed };
  } catch {
    return { ...DEFAULT_HOURS };
  }
}

export function getTechByEmail(email) {
  return getDb().prepare("SELECT * FROM techs WHERE email = ?").get(normEmail(email));
}

export function getTechById(id) {
  return getDb().prepare("SELECT * FROM techs WHERE id = ?").get(id);
}

export function getTechBySlug(slug) {
  return getDb().prepare("SELECT * FROM techs WHERE slug = ?").get(slug);
}

export function upsertTechByEmail(email, fields = {}) {
  const existing = getTechByEmail(email);
  const ts = nowIso();
  if (!existing) {
    getDb()
      .prepare(
        `INSERT INTO techs (
          email, name, paid, creem_customer_id, creem_subscription_id, creem_product_id,
          business_name, service_name, duration_minutes, service_area, timezone,
          weekly_hours, deposit_type, deposit_amount, cancel_policy, stripe_payment_link,
          slug, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        normEmail(email),
        fields.name || null,
        fields.paid ? 1 : 0,
        fields.creem_customer_id || null,
        fields.creem_subscription_id || null,
        fields.creem_product_id || null,
        fields.business_name || null,
        fields.service_name || DEFAULT_SERVICE,
        fields.duration_minutes || 120,
        fields.service_area || null,
        fields.timezone || "America/New_York",
        fields.weekly_hours || defaultHoursJson(),
        fields.deposit_type || "fixed",
        fields.deposit_amount ?? 50,
        fields.cancel_policy || DEFAULT_CANCEL_POLICY,
        fields.stripe_payment_link || null,
        fields.slug || null,
        ts,
        ts
      );
    return getTechByEmail(email);
  }
  const next = { ...existing, ...fields, updated_at: ts };
  getDb()
    .prepare(
      `UPDATE techs SET
        name = ?, paid = ?, creem_customer_id = ?, creem_subscription_id = ?,
        creem_product_id = ?, access_email_sent_at = ?, business_name = ?,
        service_name = ?, duration_minutes = ?, service_area = ?, timezone = ?,
        weekly_hours = ?, deposit_type = ?, deposit_amount = ?, cancel_policy = ?,
        stripe_payment_link = ?, slug = ?, updated_at = ?
      WHERE id = ?`
    )
    .run(
      next.name,
      next.paid ? 1 : 0,
      next.creem_customer_id,
      next.creem_subscription_id,
      next.creem_product_id,
      next.access_email_sent_at,
      next.business_name,
      next.service_name,
      next.duration_minutes,
      next.service_area,
      next.timezone,
      next.weekly_hours,
      next.deposit_type,
      next.deposit_amount,
      next.cancel_policy,
      next.stripe_payment_link,
      next.slug,
      ts,
      existing.id
    );
  return getTechById(existing.id);
}

export function markAccessEmailSent(techId) {
  getDb()
    .prepare("UPDATE techs SET access_email_sent_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), techId);
}

export function slugTaken(slug, exceptId) {
  const row = getDb()
    .prepare("SELECT id FROM techs WHERE slug = ? AND id != ?")
    .get(slug, exceptId || 0);
  return Boolean(row);
}

export function insertWebhookEvent(eventId, eventType, payload) {
  const result = getDb()
    .prepare(
      "INSERT OR IGNORE INTO webhook_events (creem_event_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?)"
    )
    .run(eventId, eventType, payload, nowIso());
  return result.changes > 0;
}

export function insertMagicLink(techId, tokenHash, expiresAt) {
  getDb()
    .prepare(
      "INSERT INTO magic_links (tech_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(techId, tokenHash, expiresAt, nowIso());
}

export function consumeMagicLink(tokenHash) {
  const row = getDb()
    .prepare("SELECT * FROM magic_links WHERE token_hash = ?")
    .get(tokenHash);
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  getDb()
    .prepare("UPDATE magic_links SET used_at = ? WHERE id = ?")
    .run(nowIso(), row.id);
  return row;
}

export function insertSession(techId, tokenHash, expiresAt) {
  getDb()
    .prepare(
      "INSERT INTO sessions (tech_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(techId, tokenHash, expiresAt, nowIso());
}

export function getSession(tokenHash) {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export function deleteSession(tokenHash) {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function insertBooking(fields) {
  const result = getDb()
    .prepare(
      `INSERT INTO bookings (
        tech_id, customer_name, customer_email, customer_phone, notes,
        start_at, end_at, status, ics_token, reminder_due_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.tech_id,
      fields.customer_name,
      fields.customer_email,
      fields.customer_phone || null,
      fields.notes || null,
      fields.start_at,
      fields.end_at,
      fields.status || "requested",
      fields.ics_token,
      fields.reminder_due_at || null,
      nowIso()
    );
  return getDb().prepare("SELECT * FROM bookings WHERE id = ?").get(result.lastInsertRowid);
}

export function getBookingByIcsToken(token) {
  return getDb().prepare("SELECT * FROM bookings WHERE ics_token = ?").get(token);
}

export function listBookingsForTech(techId) {
  return getDb()
    .prepare("SELECT * FROM bookings WHERE tech_id = ? ORDER BY start_at ASC")
    .all(techId);
}

export function slotTaken(techId, startAt, endAt, exceptId = 0) {
  const row = getDb()
    .prepare(
      `SELECT id FROM bookings
       WHERE tech_id = ?
         AND id != ?
         AND status != 'canceled'
         AND start_at < ?
         AND end_at > ?`
    )
    .get(techId, exceptId, endAt, startAt);
  return Boolean(row);
}

export function markConfirmationSent(bookingId) {
  getDb()
    .prepare("UPDATE bookings SET confirmation_sent_at = ? WHERE id = ?")
    .run(nowIso(), bookingId);
}

export function dueReminders(now = nowIso()) {
  return getDb()
    .prepare(
      `SELECT * FROM bookings
       WHERE reminder_sent_at IS NULL
         AND reminder_due_at IS NOT NULL
         AND reminder_due_at <= ?
         AND start_at > ?
         AND status != 'canceled'`
    )
    .all(now, now);
}

export function markReminderSent(bookingId) {
  getDb()
    .prepare("UPDATE bookings SET reminder_sent_at = ? WHERE id = ?")
    .run(nowIso(), bookingId);
}

export function normEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}
