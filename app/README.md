# Solo Pool Deposit Booking — fulfillment app

Minimal booking tool that unlocks after a **Creem $29/mo** SaaS subscription.

- Customer deposits, when configured, go to the **tech’s own Stripe Payment Link**. We never collect card numbers or hold funds.
- Not Jobber / Housecall Pro. No dispatch, quotes, multi-tech, CRM, or lead gen.
- Marketing waitlist stays on GitHub Pages and is **not** wired to Creem checkout: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/

See `../commerce/FULFILLMENT.md` for architecture, env vars, webhook/Success URL wiring, and leftover blockers.

## Local run

```bash
cd /workspace/solo-deposit-booking/app
cp .env.example .env
# edit .env — at minimum set SESSION_SECRET
npm install
npm test          # local fulfillment checks (no live charges)
npm start         # http://localhost:3000
```

In development (`ALLOW_DEV_GRANT=true`, not production) you can grant access without a real payment:

```bash
curl -X POST http://localhost:3000/dev/grant-access \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'
# then read data/mail.log (or GET /dev/mailbox) for the magic link
```

This is **not** a Creem charge.

## Webhook

`POST /webhooks/creem` verifies the `creem-signature` HMAC-SHA256 header against `CREEM_WEBHOOK_SECRET`. Without that secret the route fails closed (HTTP 500). Do not point the live Creem dashboard at this app until you have a public HTTPS origin **and** the real webhook secret.
