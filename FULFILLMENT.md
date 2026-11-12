# Fulfillment — Solo Pool Deposit Booking

Updated: 2026-11-12 20:35 (Asia/Shanghai)

This is the first fulfillable slice of the booking tool. It exists so a paying tech can actually get access after the live Creem $29/mo product is paid. It is **not** yet fully live: webhook dashboard wiring, a real email API key, and a durable public HTTPS origin are still missing.

## Where the app lives

- Source on the box: `/workspace/solo-deposit-booking/app/`
- Stack: small Node 22+ Express app, `node:sqlite` (no hosted database), server-rendered HTML.
- Marketing waitlist preview is unchanged in purpose: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/
- Creem checkout is **not** linked from that waitlist preview.
- `alexbigstore.com` was not changed.

## What this pass does

1. **Creem webhook** at `POST /webhooks/creem`
   - Verifies `creem-signature` (HMAC-SHA256 of the raw body with `CREEM_WEBHOOK_SECRET`), fail-closed.
   - `checkout.completed`, `subscription.paid`, and `subscription.active` mark the tech account `paid` (product id must match `prod_JyQlU86FhnSLYstg4Eaie` when present) and send the access email once.
   - `subscription.canceled`, `subscription.expired`, and `subscription.unpaid` mark the account unpaid and hide the public booking page.
   - Events are stored by Creem event id so retries are idempotent.
2. **Access email (EN)** — subject/body follow `commerce/creem-checkout.md`. Contains a one-time magic link (`/auth/magic?token=…`) to admin. No invented live API keys.
3. **Magic-link admin** — business name, service, duration, service area, timezone, weekly hours / open slots, deposit amount or percent, cancel-policy text, optional paste of the tech’s own Stripe Payment Link / Checkout URL. Stripe Connect is **not** in this pass.
4. **Public booking page** at a stable `/b/[slug]`. Customer picks a slot and books. If a Stripe link is pasted, they are sent there for the deposit; if not, the page shows a clear **“deposit not configured”** state. We never collect card numbers or hold funds.
5. After a booking: confirmation email, **ICS download**, **Google Calendar template link**. Full Google Calendar OAuth is stubbed (env placeholders only; no credentials). T-24h reminder: in-process loop every 60s, plus `POST /internal/cron/reminders` for an external cron.
6. **Thanks / cancel pages**
   - App: `GET /thanks` and `GET /cancelled` (query params such as `?session=` are ignored and do not break the page).
   - Static GitHub Pages copies, **live** as of 2026-11-12 20:32 (Asia/Shanghai) (for Creem Success / Cancel URLs even before the app has a durable origin):
     - https://xuchunsun-byte.github.io/solo-pool-deposit-booking/thanks.html
     - https://xuchunsun-byte.github.io/solo-pool-deposit-booking/cancelled.html
   - Neither static page includes the Creem checkout link.

## Local run

```bash
cd /workspace/solo-deposit-booking/app
cp .env.example .env   # set SESSION_SECRET; leave secrets empty if you do not have them
npm install
npm test               # local fulfillment checks; no live charges
npm start              # http://localhost:3000
```

Useful routes:

| Route | Purpose |
|-------|---------|
| `GET /` | App home (not the marketing waitlist) |
| `GET /thanks` | Post-payment access / thanks page |
| `GET /cancelled` | Checkout canceled; no charge |
| `GET /login` · `POST /login` | Request a magic link (only sent if the email is a paid account) |
| `GET /auth/magic?token=` | Redeem magic link, set session, go to admin |
| `GET/POST /admin` | Paid-tech settings |
| `GET/POST /b/:slug` | Public booking page |
| `GET /calendar/:token.ics` | ICS download for a booking |
| `POST /webhooks/creem` | Creem webhook |
| `POST /internal/cron/reminders` | Run due T-24h reminders (`CRON_SECRET` required in production) |
| `GET /healthz` | Liveness + whether email / webhook secret / Google OAuth env are present |

### Demo without a real charge

Only when `ALLOW_DEV_GRANT=true` and `NODE_ENV` is not `production`:

```bash
curl -X POST http://localhost:3000/dev/grant-access \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# Then: GET /dev/mailbox  or  cat data/mail.log
```

This marks the email paid and logs/sends an access link. It is **not** a Creem payment. Keep this off on any public deploy.

If no email provider is configured, every outbound message (access, confirmation, reminder, tech notify) is appended to `app/data/mail.log` so the flow can still be demonstrated.

## Environment variables

See `app/.env.example`. Never commit `.env` or real secrets.

| Variable | Role |
|----------|------|
| `PORT` / `APP_URL` | Listen port and public origin (used in magic links, booking URLs, ICS links) |
| `SESSION_SECRET` | Required in production |
| `DATABASE_PATH` | SQLite file (default `./data/app.db`) |
| `CREEM_PRODUCT_ID` | Default `prod_JyQlU86FhnSLYstg4Eaie` |
| `CREEM_WEBHOOK_SECRET` | Standard Creem webhook signing secret. If unset, `POST /webhooks/creem` returns HTTP 500 (fail closed). |
| `EMAIL_FROM` | From address |
| `RESEND_API_KEY` | Preferred mailer |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | Fallback mailer when Resend is not set |
| `CRON_SECRET` | Protects the reminder endpoint in production |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Placeholders only; OAuth not implemented this pass |
| `ALLOW_DEV_GRANT` | Local demo grant; must be false in production |
| `PUBLIC_THANKS_URL` / `PUBLIC_CANCEL_URL` | Static Pages URLs above |

## How to point Creem (a person must do this)

Dashboard wiring is **not** done in this pass: there is no documented webhook secret on hand, and a durable public HTTPS origin for the app is not guaranteed (see blockers).

When both exist:

1. **Webhook** (Creem dashboard → Developers → Webhook), live mode for store `alexbigstore` (`sto_4JRAHdDiFaT2EsNpo1PlJ3`):
   - URL: `https://<APP_ORIGIN>/webhooks/creem`
   - Events: at least `checkout.completed`, `subscription.paid`, `subscription.canceled` (also `subscription.active`, `subscription.expired`, `subscription.unpaid` if offered)
   - Copy the **live** webhook signing secret into `CREEM_WEBHOOK_SECRET` on the host (test-mode and live secrets are different).
2. **Success URL** on product `prod_JyQlU86FhnSLYstg4Eaie` (currently Creem default):
   - Preferred once the app origin is durable: `https://<APP_ORIGIN>/thanks`
   - Works today, static: `https://xuchunsun-byte.github.io/solo-pool-deposit-booking/thanks.html`
3. **Cancel URL** if/when the dashboard has a field:
   - `https://<APP_ORIGIN>/cancelled` or `https://xuchunsun-byte.github.io/solo-pool-deposit-booking/cancelled.html`
4. Do **not** hang https://www.creem.io/product/prod_JyQlU86FhnSLYstg4Eaie on the waitlist preview until fulfillment is actually live (public HTTPS + webhook secret + email provider).

## How access email is sent

On a verified grant event (or a login-link request for an already-paid email):

1. Create a one-time magic token (24h, hashed at rest).
2. Send “Your Solo Pool Deposit Booking access” via Resend, else SMTP, else `data/mail.log`.
3. Tech opens the link, gets a session cookie, lands on `/admin`.

Without `RESEND_API_KEY` or SMTP settings, the email is **not** delivered to a real inbox. The link is only in `data/mail.log`. That is a remaining blocker.

## Leftover blockers (honest)

| Blocker | Needs a person? | Notes |
|---------|-----------------|-------|
| Durable public HTTPS origin for the app | Yes | GitHub Pages cannot run this webhook/app (static only). Tried a Cloudflare quick tunnel (no account) from this box: a trycloudflare.com hostname was issued, but the process could not connect to the Cloudflare edge (`TLS handshake with edge error: EOF`; precheck: QUIC failed, HTTP/2 “blocked or unreachable”). The hostname returned HTTP 530. `ssh` to localhost.run was closed by the egress proxy (198.18.0.1:22). Paid/account hosts (Render / Fly / Railway / Vercel) would need a user login/OAuth click, which was not started. Local app works at `http://127.0.0.1:3000`. |
| `CREEM_WEBHOOK_SECRET` | Yes | Not available in this environment. Endpoint is implemented; dashboard is not pointed. |
| Email provider (`RESEND_API_KEY` or SMTP) + verified `EMAIL_FROM` | Yes | Access / confirmation / T-24h mail will only log locally until this is set. |
| Creem Success / Cancel URLs in the live product | Yes | Static Pages URLs are ready; the app `/thanks` URL can be used once there is a durable origin. Still on Creem defaults until someone changes the product. |
| Google Calendar OAuth | Later / optional | ICS + template link already work. OAuth is env-stubbed only. |
| Stripe Connect | Out of scope this pass | Techs can paste their own Payment Link. If they don’t, booking still works with a “deposit not configured” state. |
| `SESSION_SECRET` on the host | Yes, at deploy time | Required in production. |
| Do not promote / do not charge-test | — | No marketing publish, no real or simulated paid charge was run against Creem. |

## Architecture (short)

```
Creem (SaaS $29/mo) --webhook--> POST /webhooks/creem
                                 verify HMAC → upsert tech.paid
                                 → access email (magic link)
Tech browser --> /auth/magic → session → /admin (settings, slug)
Customer     --> /b/:slug → book slot
                 if Stripe Payment Link pasted → customer goes to tech's Stripe
                 else "deposit not configured" (no card collection)
                 → confirmation email + ICS + GCal template
                 → T-24h reminder hook
```

Two money flows stay separate: Creem = tech SaaS; customer deposit = tech’s Stripe. We are not an escrow.
