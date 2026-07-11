# Bastah Backend — Roadmap (Pages 1 & 2)

This is the detailed plan behind `CLAUDE.md`. It covers the mental model, the
data model, every endpoint we need for the **Home** and **Shop & Discovery**
pages (plus the supporting features they trigger), and the exact order to build
things in.

---

## 1. The mental model (read this first)

A backend is three layers stacked on top of each other:

1. **The database** stores the data (shops, products, prices, users…).
2. **The models** describe the *shape* of that data (what fields a product has).
3. **The API** is a set of URLs ("endpoints") that the frontend calls to read or
   change data. Example: the frontend asks `GET /api/products/123` and gets back
   that product as JSON.

You will build them bottom-up: connect the database → define a model → expose an
endpoint → test it in Postman → move to the next feature. You never need the
frontend to make progress; Postman plays the role of the frontend while we build.

**The one idea that makes Bastah work:** we separate a *canonical product* (the
real-world item, e.g. "1kg white sugar") from a *listing* (one shop's price for
that item). Many shops can have a listing for the same product. That's what makes
"compare prices across shops" a single, clean database query instead of messy
name-matching.

---

## 2. Data model

Each of these becomes one Mongoose "model" (roughly, one collection/table).

### User
`name`, `email` (unique), `passwordHash`, `phone`, `role` (`admin|seller|customer`), `createdAt`
- Passwords are never stored as plain text — only the bcrypt hash.

### Category
`name`, `nameAr`, `slug`, `icon?`, `parent?` (for sub-categories)
- Seedable list (from the visual map: Men, Women, Kids, Electronics & Home,
  Health, Sports…). A small fixed list you insert once with a seed script.

### Shop
`owner` (→User), `name`, `area`, `address`, `phone`, `description`, `logoUrl?`,
`category?`, `isActive`, `isVerified`, `ratingAvg`, `ratingCount`, `createdAt`
- `ratingAvg`/`ratingCount` are kept up to date whenever a review is added, so
  "top stores" and store ratings are instant to read.

### Product (the canonical catalog item)
`name`, `nameAr`, `description`, `category` (→Category), `unit`, `imageUrl?`, `createdAt`
- One document per real-world item, shared across all shops that sell it.

### Listing (a shop's price for a product) — the heart of the app
`shop` (→Shop), `product` (→Product), `price` (Number, ILS), `inStock` (Boolean), `updatedAt`
- **Unique index on `(shop, product)`** so a shop can't list the same product twice.
- Price comparison = "find all Listings for this Product, attach each shop, sort
  by price ascending." That single query powers Product Details.

### Review
`author` (→User), `shop` (→Shop), `rating` (1–5), `comment`, `createdAt`
- MVP reviews target shops (seller ratings). Product reviews can come later.

### Cart (one per customer)
`customer` (→User), `items: [{ listing (→Listing), quantity }]`
- This is "add to cart." Because a cart item points to a *listing*, it already
  knows which shop and which price.

### Wishlist (one per customer)
`customer` (→User), `products: [ (→Product) ]`
- This is "save products."

### Order (defined now, built later — not part of Pages 1 & 2)
`customer`, `shop`, `items: [{ listing, quantity, priceAtOrder }]`,
`status` (`pending|accepted|ready|completed|cancelled`), `note`, `contactPhone`
- `priceAtOrder` snapshots the agreed price, because prices change daily.
- Remember: no payment — an order just connects the customer to the seller.

---

## 3. Endpoints, grouped by the page they serve

`(public)` = anyone can call. `(auth)` = must be logged in. `(seller)` /
`(admin)` = must have that role.

### Auth (needed before anything that writes data)
- `POST /api/auth/register` — create an account (public)
- `POST /api/auth/login` — get a JWT token (public)
- `GET  /api/auth/me` — who am I (auth)

### Seller setup (needed so the browse pages have data to show)
- `POST  /api/shops` — a seller creates their shop (seller)
- `PATCH /api/shops/:id` — edit shop (seller, owner only)
- `POST  /api/products` — add a catalog product (seller/admin)
- `POST  /api/shops/:id/listings` — add a price for a product (seller)
- `PATCH /api/listings/:id` — update price / stock (seller)

### Page 1 — Home (الرئيسية)
- `GET /api/products?featured=true&limit=` — featured offers (public)
- `GET /api/products?sort=newest&limit=` — new arrivals (public)
- `GET /api/shops?sort=rating&limit=` — top stores (public)
- `GET /api/products?limit=` — browse products (public)
- *(optional)* `GET /api/home` — one call that bundles the four above

### Page 2 — Shop & Discovery (التسوق والاستكشاف)
- `GET  /api/categories` — list categories (public)
- `GET  /api/categories/:id/products` — products in a category (public)
- `GET  /api/shops` — store directory, with ratings (public)
- `GET  /api/shops/:id` — store profile: info + rating (public)
- `GET  /api/shops/:id/products` — a shop's listings (public)
- `GET  /api/products/search?q=&category=&minPrice=&maxPrice=&sort=` — search + filter + sort (public)
- `GET  /api/products/:id` — product details (public)
- `GET  /api/products/:id/listings` — **compare prices / available stores**, sorted cheapest-first (public)
- `GET  /api/shops/:id/reviews` — read reviews (public)
- `POST /api/shops/:id/reviews` — leave a review (auth, customer)

### Supporting features triggered from these pages
- `GET    /api/cart` — view my cart (auth)
- `POST   /api/cart/items` — add a listing to cart (auth)
- `PATCH  /api/cart/items/:listingId` — change quantity (auth)
- `DELETE /api/cart/items/:listingId` — remove item (auth)
- `GET    /api/wishlist` — view saved products (auth)
- `POST   /api/wishlist/:productId` — save a product (auth)
- `DELETE /api/wishlist/:productId` — unsave (auth)

---

## 4. Changes from the visual map (and why)

- **Payment page → order confirmation / contact seller.** No money in the app,
  so there's nothing to "pay." The seller gets the request and follows up.
- **Delivery Selection → optional pickup/meetup note.** No delivery logistics;
  at most a text field on an order.
- **AI Shopping/Seller/Admin Assistants → later (bonus).** Nice for the defense,
  but a whole feature of their own. Not in the MVP.
- **Added `Category` model.** The map introduced categories; the original
  proposal didn't model them, so we add it.

---

## 5. Build order (do these one at a time, test each in Postman)

1. **Scaffold** — Express app, `.env`, MongoDB connection, a `GET /api/health`
   route that returns `{ ok: true }`, and one central error handler. Goal: prove
   the server runs and reaches the database.
2. **Auth + roles** — User model; register & login (bcrypt + JWT); an `auth`
   middleware that verifies the token; a `requireRole` middleware; `GET /me`.
   Test the whole loop: register → login → call a protected route.
3. **Categories** — model + a seed script + the two GET endpoints.
4. **Shops** — create/update (seller) + browse/profile (public). Test.
5. **Products + Listings** — Product model; Listing model with the unique
   `(shop, product)` index; seller endpoints to add a product, add a listing,
   and update price/stock. Test.
6. **Search + price comparison** — the search endpoint (query, filters, sort),
   product details, and listings-by-product. This lights up **Search Results**
   and **Product Details** (the comparison feature).
7. **Reviews** — post/list reviews and keep `ratingAvg`/`ratingCount` on the shop
   updated. This lights up **Top Stores** and seller ratings.
8. **Cart** — add / update / remove. This is **add to cart**.
9. **Wishlist** — save / unsave. This is **save products**.
10. **Home aggregation** — the featured / new-arrivals / top-stores endpoints
    (these mostly compose data that already exists), plus the optional bundled
    `GET /api/home`.

**Golden rule:** get one *vertical slice* working end-to-end before stacking the
next feature — e.g. finish register → login → protected route (step 2) fully
before touching shops. It proves the foundation is solid.

---

## 6. Testing & demo data
- Keep a **Postman collection** with one folder per feature.
- Write a **seed script** that inserts a few demo categories, shops, products,
  and listings, so the browse pages have something real to return while there's
  no frontend. Re-run it any time you reset the database.

---

## First command to run in Claude Code (VS Code)

> Start with step 1 only. Create the Express scaffold: `app.js`, `server.js`, a
> `config/` folder with the MongoDB connection, a `GET /api/health` route, a
> central error handler, a `.env` (and `.env.example`), and a `package.json`
> with the scripts to run it. Explain each file as you create it, then tell me
> exactly how to start the server and test the health route in Postman. Do not
> build any other feature yet.
