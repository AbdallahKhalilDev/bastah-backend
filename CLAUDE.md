# Bastah — Project Memory (CLAUDE.md)

> This file is read automatically at the start of every Claude Code session.
> Keep it short and high-signal. The detailed plan lives in `docs/ROADMAP.md`.

## What Bastah is
A web + mobile marketplace for Gaza that connects customers with local shops and
their products and prices. The core value is browsing and **comparing the same
product's price across multiple shops** in one place, then contacting/ordering
from a shop directly. Prices change daily, so freshness matters.

## Hard constraints (do not violate)
- **No money changes hands in the app.** No payment processing, no cards/wallets.
  An "order" = a connection/reservation request that the seller fulfills offline.
- **Currency is the Israeli Shekel (₪ / ILS).** Prices are plain numbers; never
  assume USD.
- **Real-time price push (WebSockets/Socket.io) is planned but NOT built yet.**
  For now prices are simply current on each fetch. Do not add Socket.io until
  explicitly asked.
- Stay within the MVP roadmap. Payment pages, delivery logistics, and the AI
  assistants shown in the visual map are OUT of scope for now.

## The developer
Learning backend and databases for the first time. When building, **explain what
you are doing and why, in plain language.** Prefer small, readable steps over
clever code. Introduce one new concept at a time.

## Tech stack
- Node.js + Express.js
- MongoDB with Mongoose
- Auth: JWT + bcrypt password hashing
- Validation: zod
- Testing: Postman (manual), plus lightweight automated tests where useful

## Conventions
- Folder layout: `config/ models/ controllers/ routes/ middleware/ utils/`,
  with entry points `app.js` (builds the app) and `server.js` (starts it).
- Route files stay thin; real logic lives in controllers.
- Every route that changes data checks authentication + role FIRST.
- Use `async/await` with a single central error handler. No unhandled promises.
- Secrets go in `.env` (never committed). Commit a `.env.example` instead.
- Price fields: `Number`, in ILS.

## Roles
`admin`, `seller`, `customer`

## Where we are / what's next
Building the backend for the first two pages of the visual map — **Home** and
**Shop & Discovery** — plus the supporting pieces those pages trigger:
add-to-cart, wishlist, and reviews/ratings.

The full data model, all endpoints grouped by page, and the ordered build plan
are in **`docs/ROADMAP.md`**. Read it before starting a work session.

**Progress:** Step 1 (scaffold + `/api/health` + Mongo connection) done and
committed. Next: Step 2 — Auth + roles.
