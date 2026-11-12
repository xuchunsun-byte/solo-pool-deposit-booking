# Solo Pool Deposit Booking — Landing

Static HTML landing for a deposit booking page aimed at **solo / one-truck pool techs** (US).

Buyer-facing English only. **Not Jobber.** The $29/mo SaaS plan is live via Creem. Customer deposits stay on the tech’s own Stripe—we do not hold or escrow those funds.

## Live pages

- Landing: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/
- Customer-flow mocks: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/mocks.html
- After payment / claim access: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/thanks.html
- Checkout canceled: https://xuchunsun-byte.github.io/solo-pool-deposit-booking/cancelled.html

## Checkout

Official Creem product (L1, $29.00 USD/month):

https://www.creem.io/product/prod_JyQlU86FhnSLYstg4Eaie

Primary CTAs on the landing go to this URL. Do not invent another checkout link.

## Access after payment

Paid subscribers submit the access form on `thanks.html`:

https://airtable.com/appPMLNN2CuzBQ71Y/pag5o5zl8Pe1IfFMv/form

We provision a public booking page and email the link to the checkout address, usually within one business day. This is the no-cost fulfillment path while the full login app is not hosted.

## Waitlist (optional)

People who are not ready to subscribe can still join:

https://airtable.com/appPMLNN2CuzBQ71Y/pagaLs3BoLGdLYfA7/form

## Files

| File | What |
|------|------|
| `index.html` | Marketing landing + $29/mo checkout CTAs + optional waitlist |
| `thanks.html` | Post-payment access instructions + access form |
| `cancelled.html` | Checkout canceled; not charged |
| `mocks.html` | 3 customer-flow wireframes (pick slot → pay deposit → confirmed) |
| `styles.css` | Shared styles |

Isolated from Newsletter Sponsorship, Chrome Trade Lead, n8n Lead Ops, and Email Deliverability products.
