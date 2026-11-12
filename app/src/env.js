import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(root = APP_ROOT) {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function config() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const port = Number(process.env.PORT || 3000);
  const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, "");
  return {
    nodeEnv,
    isProd: nodeEnv === "production",
    port,
    appUrl,
    sessionSecret: process.env.SESSION_SECRET || "",
    databasePath: process.env.DATABASE_PATH || resolve(APP_ROOT, "data", "app.db"),
    creemProductId: process.env.CREEM_PRODUCT_ID || "prod_JyQlU86FhnSLYstg4Eaie",
    creemWebhookSecret: process.env.CREEM_WEBHOOK_SECRET || "",
    cronSecret: process.env.CRON_SECRET || "",
    emailFrom: process.env.EMAIL_FROM || "",
    resendApiKey: process.env.RESEND_API_KEY || "",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
      secure: String(process.env.SMTP_SECURE || "false") === "true",
    },
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    allowDevGrant: String(process.env.ALLOW_DEV_GRANT || "") === "true",
    publicThanksUrl:
      process.env.PUBLIC_THANKS_URL ||
      "https://xuchunsun-byte.github.io/solo-pool-deposit-booking/thanks.html",
    publicCancelUrl:
      process.env.PUBLIC_CANCEL_URL ||
      "https://xuchunsun-byte.github.io/solo-pool-deposit-booking/cancelled.html",
  };
}
