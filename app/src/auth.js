import { randomBytes, createHash } from "node:crypto";
import {
  insertMagicLink,
  consumeMagicLink,
  insertSession,
  getSession,
  deleteSession,
  getTechById,
} from "./db.js";

const COOKIE = "spdb_session";
const MAGIC_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken() {
  return randomBytes(32).toString("hex");
}

export function createMagicToken(techId) {
  const token = newToken();
  const expires = new Date(Date.now() + MAGIC_TTL_MS).toISOString();
  insertMagicLink(techId, hashToken(token), expires);
  return token;
}

export function redeemMagicToken(token) {
  const row = consumeMagicLink(hashToken(token));
  if (!row) return null;
  return getTechById(row.tech_id);
}

export function createSession(techId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  insertSession(techId, hashToken(token), expires);
  return { token, expires };
}

export function sessionCookie(token, { secure, maxAge = SESSION_TTL_MS / 1000 } = {}) {
  const parts = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAge)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie({ secure } = {}) {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = decodeURIComponent(trimmed.slice(eq + 1));
  }
  return out;
}

export function currentTech(req) {
  const token = readCookies(req)[COOKIE];
  if (!token) return null;
  const session = getSession(hashToken(token));
  if (!session) return null;
  return getTechById(session.tech_id);
}

export function logout(req) {
  const token = readCookies(req)[COOKIE];
  if (token) deleteSession(hashToken(token));
}

export function magicUrl(appUrl, token) {
  return `${appUrl}/auth/magic?token=${encodeURIComponent(token)}`;
}
