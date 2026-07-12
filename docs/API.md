# Bastah API Reference

This is the complete HTTP API for the Bastah backend, written for a frontend
developer connecting a separate frontend. Every endpoint below was read directly
from the routes, controllers, and models — nothing here is aspirational.

---

## Getting started

### Base URL

Everything lives under:

```
http://localhost:3000/api
```

So `POST /api/auth/login` is `http://localhost:3000/api/auth/login`.
(The port is `PORT` from `.env`, defaulting to `3000`.)

### Sending requests

- **Bodies are JSON.** Send `Content-Type: application/json` on every POST/PATCH.
- **Auth uses a bearer token.** Register + login are public. After you log in you
  get a JWT string; send it on **every authenticated request** as:

  ```
  Authorization: Bearer <token>
  ```

  A missing/garbled token → `401`. A valid token but the wrong role → `403`.

### Roles

There are three roles: `customer` (the default for new sign-ups), `seller`, and
`admin`. Each endpoint below states what it needs: **public**, **customer**,
**seller**, or **admin**. Where it says "seller / admin", a seller may only act
on **their own** shop/listing; an admin may act on any.

### Pagination

List endpoints that can grow large are **paginated**: they return the list under
a resource-named key **plus** `page`, `limit`, and `total`, e.g.

```json
{ "products": [ /* ... */ ], "page": 1, "limit": 20, "total": 137 }
```

Control them with `?page=` (default `1`, min `1`) and `?limit=` (default `20`,
**max `50`** — larger values are clamped, not rejected). `total` is the count
across all pages so you can render "page 1 of N".

The **paginated** endpoints are: `GET /api/products`, `GET /api/products/search`,
`GET /api/products/new`, and `GET /api/shops/:shopId/reviews`.

Other list endpoints return a **fixed or capped** list in full (no `page`/`total`):
`GET /api/categories`, `GET /api/shops`, `GET /api/shops/top`,
`GET /api/products/featured`, `GET /api/shops/:shopId/products`,
`GET /api/products/:id/listings`, and `GET /api/home`. The capped ones
(`/shops/top`, `/products/featured`) accept `?limit=` (default `10`, max `50`).

### Conventions in the responses

- **IDs** are MongoDB ObjectIds — 24-char hex strings like
  `"665f1a2b3c4d5e6f70819a2b"`.
- Every stored document carries **`createdAt`** and **`updatedAt`** ISO-8601
  timestamps, and a Mongoose **`__v`** version key you can ignore. (Examples below
  show `__v` once, then omit it for brevity.)
- **Prices are plain numbers in Israeli Shekels (₪ / ILS)** — no currency string,
  no cents object. `5` means ₪5.
- A **reference field** (like a shop's `category` or `owner`) is sometimes returned
  as a bare id string and sometimes as a nested object — depending on whether that
  endpoint "populates" it. Each endpoint below says which.

### Errors

Every error has the same shape — a single `error` string:

```json
{ "error": "Shop not found" }
```

Common statuses you'll see across the API:

| Status | Meaning | Example message |
| ------ | ------- | --------------- |
| `400`  | Bad input — failed validation, or a malformed id | `"Invalid shop id"` |
| `401`  | Not authenticated — missing/expired/invalid token | `"Not authenticated"`, `"Invalid or expired token"` |
| `403`  | Authenticated but not allowed (wrong role, or not your resource) | `"Forbidden"` |
| `404`  | No such resource (or it's hidden/inactive) | `"Product not found"` |
| `409`  | Conflict — the thing already exists | `"Email already registered"` |
| `500`  | Unhandled server error | `"Something went wrong"` |

A `400` from a body-validation failure returns the **first** problem found, e.g.
`{ "error": "Password must be at least 6 characters" }`. Hitting a URL that isn't
a route at all returns `404 { "error": "Route not found" }`.

---

## Health

### `GET /api/health`
**Auth:** public.

A liveness check. No body, no params.

**200**
```json
{ "ok": true }
```

---

## Auth

### `POST /api/auth/register`
**Auth:** public.

Creates a new user. New users are always created as `customer` (role can't be set
here). The password is hashed with bcrypt; the raw password is never stored or
returned.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | string | ✅ | Non-empty |
| `email` | string | ✅ | Valid email; stored lowercased; must be unique |
| `password` | string | ✅ | Min 6 characters |
| `phone` | string | ✅ | Non-empty |

**Example request**
```json
{
  "name": "Sara Ahmed",
  "email": "sara@example.com",
  "password": "secret123",
  "phone": "0599123456"
}
```

**201**
```json
{
  "user": {
    "id": "665f1a2b3c4d5e6f70819a2b",
    "name": "Sara Ahmed",
    "email": "sara@example.com",
    "phone": "0599123456",
    "role": "customer",
    "createdAt": "2026-07-12T10:15:00.000Z"
  }
}
```

**Errors**
- `400` — validation, e.g. `{ "error": "A valid email is required" }`
- `409` — `{ "error": "Email already registered" }`

---

### `POST /api/auth/login`
**Auth:** public.

Exchanges credentials for a JWT. On any failure (unknown email **or** wrong
password) you get the **same** generic `401`, on purpose.

**Body**

| Field | Type | Required |
| ----- | ---- | -------- |
| `email` | string (email) | ✅ |
| `password` | string | ✅ |

**Example request**
```json
{ "email": "sara@example.com", "password": "secret123" }
```

**200**
```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6..." }
```

Store this token and send it as `Authorization: Bearer <token>` from now on.

**Errors**
- `400` — validation, e.g. `{ "error": "A valid email is required" }`
- `401` — `{ "error": "Invalid email or password" }`

---

### `GET /api/auth/me`
**Auth:** any logged-in user (customer / seller / admin).

Returns the current user, reloaded fresh from the database.

**200**
```json
{
  "user": {
    "id": "665f1a2b3c4d5e6f70819a2b",
    "name": "Sara Ahmed",
    "email": "sara@example.com",
    "phone": "0599123456",
    "role": "customer",
    "createdAt": "2026-07-12T10:15:00.000Z"
  }
}
```

**Errors**
- `401` — no/invalid token
- `404` — `{ "error": "User not found" }` (token valid but the user was deleted)

---

## Categories

### `GET /api/categories`
**Auth:** public.

All **active** categories, sorted A→Z by English `name`. Not paginated.

**200**
```json
{
  "categories": [
    {
      "_id": "665f00aa11bb22cc33dd44ee",
      "name": "Groceries",
      "nameAr": "بقالة",
      "slug": "groceries",
      "icon": "basket",
      "parent": null,
      "isActive": true,
      "createdAt": "2026-06-01T08:00:00.000Z",
      "updatedAt": "2026-06-01T08:00:00.000Z",
      "__v": 0
    }
  ]
}
```

`parent` is either `null` (top-level) or another category's id. `icon` may be
absent.

---

### `GET /api/categories/:id`
**Auth:** public.

One category by id.

**200**
```json
{
  "category": {
    "_id": "665f00aa11bb22cc33dd44ee",
    "name": "Groceries",
    "nameAr": "بقالة",
    "slug": "groceries",
    "icon": "basket",
    "parent": null,
    "isActive": true,
    "createdAt": "2026-06-01T08:00:00.000Z",
    "updatedAt": "2026-06-01T08:00:00.000Z"
  }
}
```

**Errors**
- `400` — `{ "error": "Invalid category id" }`
- `404` — `{ "error": "Category not found" }`

---

## Shops

A shop's `owner` and `ratingAvg`/`ratingCount`/`isVerified` are **system-managed**
— you can't set them via the create/update body (they're stripped). Ratings are
recomputed from reviews; `isVerified` is admin-controlled.

### `GET /api/shops`
**Auth:** public.

All **active** shops, sorted by `name`. `category` is fully populated; `owner` is
populated to **name only** (no email/credentials ever leak). Not paginated.

**200**
```json
{
  "shops": [
    {
      "_id": "665f77aa88bb99cc00dd11ee",
      "owner": { "_id": "665f1a2b3c4d5e6f70819a2b", "name": "Abu Ali" },
      "name": "Abu Ali Store",
      "phone": "0599000111",
      "area": "Rimal",
      "address": "Omar Al-Mukhtar St",
      "description": "Groceries and household goods",
      "logoUrl": "https://example.com/logo.png",
      "category": {
        "_id": "665f00aa11bb22cc33dd44ee",
        "name": "Groceries",
        "nameAr": "بقالة",
        "slug": "groceries",
        "icon": "basket",
        "parent": null,
        "isActive": true
      },
      "isActive": true,
      "isVerified": true,
      "ratingAvg": 4.7,
      "ratingCount": 12,
      "createdAt": "2026-06-10T09:00:00.000Z",
      "updatedAt": "2026-07-01T09:00:00.000Z"
    }
  ]
}
```

`category` is `null` when the shop has none. Optional fields (`area`, `address`,
`description`, `logoUrl`) may be absent.

---

### `GET /api/shops/top`
**Auth:** public.

The Home page "top stores" strip: best-rated **active** shops, sorted by
`ratingAvg` desc then `ratingCount` desc. Capped, not paginated. Returns only the
safe public fields (no `owner`, no `address`, no `description`).

**Query:** `?limit=` (default `10`, max `50`).

**200**
```json
{
  "shops": [
    {
      "_id": "665f77aa88bb99cc00dd11ee",
      "name": "Abu Ali Store",
      "area": "Rimal",
      "phone": "0599000111",
      "logoUrl": "https://example.com/logo.png",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "ratingAvg": 4.7,
      "ratingCount": 12,
      "isVerified": true,
      "createdAt": "2026-06-10T09:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/shops/:id`
**Auth:** public.

One shop by id. Inactive shops are treated as not found. Same populated shape as
`GET /api/shops` (full `category`, `owner` = `{ _id, name }`).

**200**
```json
{
  "shop": {
    "_id": "665f77aa88bb99cc00dd11ee",
    "owner": { "_id": "665f1a2b3c4d5e6f70819a2b", "name": "Abu Ali" },
    "name": "Abu Ali Store",
    "phone": "0599000111",
    "area": "Rimal",
    "address": "Omar Al-Mukhtar St",
    "description": "Groceries and household goods",
    "logoUrl": "https://example.com/logo.png",
    "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة", "slug": "groceries" },
    "isActive": true,
    "isVerified": true,
    "ratingAvg": 4.7,
    "ratingCount": 12,
    "createdAt": "2026-06-10T09:00:00.000Z",
    "updatedAt": "2026-07-01T09:00:00.000Z"
  }
}
```

**Errors**
- `400` — `{ "error": "Invalid shop id" }`
- `404` — `{ "error": "Shop not found" }` (missing **or** inactive)

---

### `POST /api/shops`
**Auth:** seller or admin.

Creates a shop **owned by the caller** (`owner` comes from your token, never the
body).

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | string | ✅ | Non-empty |
| `phone` | string | ✅ | Non-empty |
| `area` | string | ❌ | |
| `address` | string | ❌ | |
| `description` | string | ❌ | |
| `logoUrl` | string | ❌ | |
| `category` | string (id) | ❌ | Must be a real category |
| `isActive` | boolean | ❌ | Defaults to `true` |

Any other field (`owner`, `isVerified`, `ratingAvg`, …) is silently ignored.

**Example request**
```json
{
  "name": "Abu Ali Store",
  "phone": "0599000111",
  "area": "Rimal",
  "category": "665f00aa11bb22cc33dd44ee"
}
```

**201** — note `owner` and `category` come back as **bare ids** here (create does
not populate):
```json
{
  "shop": {
    "_id": "665f77aa88bb99cc00dd11ee",
    "owner": "665f1a2b3c4d5e6f70819a2b",
    "name": "Abu Ali Store",
    "phone": "0599000111",
    "area": "Rimal",
    "category": "665f00aa11bb22cc33dd44ee",
    "isActive": true,
    "isVerified": false,
    "ratingAvg": 0,
    "ratingCount": 0,
    "createdAt": "2026-07-12T11:00:00.000Z",
    "updatedAt": "2026-07-12T11:00:00.000Z",
    "__v": 0
  }
}
```

**Errors**
- `400` — validation, or `{ "error": "Invalid category id" }`, or `{ "error": "Category not found" }`
- `401` — not logged in
- `403` — role isn't seller/admin

---

### `PATCH /api/shops/:id`
**Auth:** seller (own shop only) or admin (any shop).

Updates only the fields you send. `name`/`phone` must stay non-empty **if
present**. System fields can't be touched.

**Body** — all optional: `name`, `phone`, `area`, `address`, `description`,
`logoUrl`, `category` (id), `isActive` (boolean).

**Example request**
```json
{ "area": "Tel al-Hawa", "isActive": false }
```

**200** — returns the updated shop (`owner`/`category` come back as ids):
```json
{
  "shop": {
    "_id": "665f77aa88bb99cc00dd11ee",
    "owner": "665f1a2b3c4d5e6f70819a2b",
    "name": "Abu Ali Store",
    "phone": "0599000111",
    "area": "Tel al-Hawa",
    "category": "665f00aa11bb22cc33dd44ee",
    "isActive": false,
    "isVerified": false,
    "ratingAvg": 0,
    "ratingCount": 0,
    "createdAt": "2026-07-12T11:00:00.000Z",
    "updatedAt": "2026-07-12T11:30:00.000Z"
  }
}
```

**Errors**
- `400` — invalid shop id, validation, or bad/unknown `category`
- `401` — not logged in
- `403` — `{ "error": "Forbidden" }` (a seller editing a shop that isn't theirs)
- `404` — `{ "error": "Shop not found" }`

---

## Products

A product is the **canonical catalog item** (e.g. "1kg white sugar"), not a price.
Prices live on **listings** (see below). `isFeatured` is admin-only editorial and
can't be set via create/update.

### `GET /api/products`
**Auth:** public. **Paginated.**

Browse the catalog, newest first. `category` is populated to `{ _id, name, nameAr }`.

**Query:** `?page=` (default 1), `?limit=` (default 20, max 50).

**200**
```json
{
  "products": [
    {
      "_id": "665faa11bb22cc33dd44ee55",
      "name": "White Sugar 1kg",
      "nameAr": "سكر أبيض 1كغ",
      "description": "Refined white cane sugar",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "unit": "kg",
      "imageUrl": "https://example.com/sugar.png",
      "isFeatured": false,
      "createdAt": "2026-07-05T08:00:00.000Z",
      "updatedAt": "2026-07-05T08:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 137
}
```

`description`, `unit`, and `imageUrl` may be absent.

---

### `GET /api/products/search`
**Auth:** public. **Paginated.**

Search + filter + sort the catalog. Every param is optional — with none, it behaves
like the browse list.

**Query**

| Param | Type | Notes |
| ----- | ---- | ----- |
| `q` | string | Case-insensitive **partial** match on `name` OR `nameAr` |
| `category` | string (id) | Filter to one category |
| `sort` | string | `name` → A→Z; anything else (or omitted) → newest first |
| `page` | number | default 1 |
| `limit` | number | default 20, max 50 |

**Example**
```
GET /api/products/search?q=sug&sort=name&page=1&limit=10
```

**200** — same shape as `GET /api/products`:
```json
{ "products": [ /* ... */ ], "page": 1, "limit": 10, "total": 3 }
```

**Errors**
- `400` — `{ "error": "Invalid category id" }` (only if `category` is malformed)

---

### `GET /api/products/featured`
**Auth:** public. Capped list (not paginated).

The Home "featured offers" strip: products an admin flagged (`isFeatured: true`),
newest first. **Fallback:** if nothing is flagged yet, it returns the newest
products instead, so the strip is never empty.

**Query:** `?limit=` (default `10`, max `50`).

**200**
```json
{
  "products": [
    {
      "_id": "665faa11bb22cc33dd44ee55",
      "name": "White Sugar 1kg",
      "nameAr": "سكر أبيض 1كغ",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "unit": "kg",
      "imageUrl": "https://example.com/sugar.png",
      "isFeatured": true,
      "createdAt": "2026-07-05T08:00:00.000Z",
      "updatedAt": "2026-07-05T08:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/products/new`
**Auth:** public. **Paginated.**

New arrivals — newest products by `createdAt`. Same `{ products, page, limit, total }`
shape as `GET /api/products`.

**Query:** `?page=`, `?limit=` (default 20, max 50).

---

### `GET /api/products/:id`
**Auth:** public.

One product, with `category` populated to `{ _id, name, nameAr }`.

**200**
```json
{
  "product": {
    "_id": "665faa11bb22cc33dd44ee55",
    "name": "White Sugar 1kg",
    "nameAr": "سكر أبيض 1كغ",
    "description": "Refined white cane sugar",
    "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
    "unit": "kg",
    "imageUrl": "https://example.com/sugar.png",
    "isFeatured": false,
    "createdAt": "2026-07-05T08:00:00.000Z",
    "updatedAt": "2026-07-05T08:00:00.000Z"
  }
}
```

**Errors**
- `400` — `{ "error": "Invalid product id" }`
- `404` — `{ "error": "Product not found" }`

---

### `GET /api/products/:id/listings`  — price comparison
**Auth:** public.

**The headline feature.** Given one product, returns every **active** shop's price
for it, **cheapest first**. Only safe shop fields are exposed. Listings from
inactive or deleted shops are filtered out.

**200**
```json
{
  "product": {
    "_id": "665faa11bb22cc33dd44ee55",
    "name": "White Sugar 1kg",
    "nameAr": "سكر أبيض 1كغ",
    "imageUrl": "https://example.com/sugar.png",
    "unit": "kg"
  },
  "listings": [
    {
      "_id": "665fcc11dd22ee33ff4400aa",
      "price": 5,
      "inStock": true,
      "shop": {
        "_id": "665f77aa88bb99cc00dd11ee",
        "name": "Abu Ali Store",
        "area": "Rimal",
        "phone": "0599000111",
        "ratingAvg": 4.7,
        "ratingCount": 12
      }
    },
    {
      "_id": "665fcc11dd22ee33ff4400bb",
      "price": 6,
      "inStock": false,
      "shop": {
        "_id": "665f77aa88bb99cc00dd22ff",
        "name": "Gaza Mart",
        "area": "Nasr",
        "phone": "0599222333",
        "ratingAvg": 4.2,
        "ratingCount": 8
      }
    }
  ]
}
```

If no active shop lists it, `listings` is `[]` (still `200`).

**Errors**
- `400` — `{ "error": "Invalid product id" }`
- `404` — `{ "error": "Product not found" }`

---

### `POST /api/products`
**Auth:** seller or admin.

Creates a canonical catalog product. `isFeatured` cannot be set here.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `name` | string | ✅ | Non-empty |
| `nameAr` | string | ✅ | Non-empty (Arabic name) |
| `category` | string (id) | ✅ | Must be a real category |
| `description` | string | ❌ | |
| `unit` | string | ❌ | e.g. `"kg"`, `"L"`, `"piece"` |
| `imageUrl` | string | ❌ | |

**Example request**
```json
{
  "name": "White Sugar 1kg",
  "nameAr": "سكر أبيض 1كغ",
  "category": "665f00aa11bb22cc33dd44ee",
  "unit": "kg"
}
```

**201** — `category` is populated (full document) on the response:
```json
{
  "product": {
    "_id": "665faa11bb22cc33dd44ee55",
    "name": "White Sugar 1kg",
    "nameAr": "سكر أبيض 1كغ",
    "category": {
      "_id": "665f00aa11bb22cc33dd44ee",
      "name": "Groceries",
      "nameAr": "بقالة",
      "slug": "groceries",
      "isActive": true
    },
    "unit": "kg",
    "isFeatured": false,
    "createdAt": "2026-07-12T12:00:00.000Z",
    "updatedAt": "2026-07-12T12:00:00.000Z",
    "__v": 0
  }
}
```

**Errors**
- `400` — validation, `{ "error": "Invalid category id" }`, or `{ "error": "Category not found" }`
- `401` / `403`

---

### `PATCH /api/products/:id/feature`
**Auth:** **admin only.**

Feature or un-feature a product for the Home page. Idempotent — it sets the exact
value you send.

**Body**

| Field | Type | Required |
| ----- | ---- | -------- |
| `isFeatured` | boolean | ✅ |

**Example request**
```json
{ "isFeatured": true }
```

**200** — returns the product with `category` populated to `{ _id, name, nameAr }`:
```json
{
  "product": {
    "_id": "665faa11bb22cc33dd44ee55",
    "name": "White Sugar 1kg",
    "nameAr": "سكر أبيض 1كغ",
    "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
    "unit": "kg",
    "isFeatured": true,
    "createdAt": "2026-07-05T08:00:00.000Z",
    "updatedAt": "2026-07-12T12:30:00.000Z"
  }
}
```

**Errors**
- `400` — validation (`{ "error": "..." }`) or `{ "error": "Invalid product id" }`
- `401` — not logged in
- `403` — not an admin
- `404` — `{ "error": "Product not found" }`

---

## Listings

A **listing** is *one shop's price for one product* — the bridge that makes price
comparison work. A shop can list a given product **at most once** (enforced by a
unique index). Note the URLs: you **create** a listing under a shop, but **edit /
delete** it by its own id.

### `POST /api/shops/:shopId/listings`
**Auth:** seller (own shop only) or admin.

Adds a price for a product to this shop.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `product` | string (id) | ✅ | Must be a real product |
| `price` | number | ✅ | Must be a JSON **number** (not `"5"`), `≥ 0`, in ILS |
| `inStock` | boolean | ❌ | Defaults to `true` |

**Example request**
```json
{ "product": "665faa11bb22cc33dd44ee55", "price": 5, "inStock": true }
```

**201** — `product` is populated to `{ _id, name, nameAr, imageUrl, unit }`;
`shop` is the bare id:
```json
{
  "listing": {
    "_id": "665fcc11dd22ee33ff4400aa",
    "shop": "665f77aa88bb99cc00dd11ee",
    "product": {
      "_id": "665faa11bb22cc33dd44ee55",
      "name": "White Sugar 1kg",
      "nameAr": "سكر أبيض 1كغ",
      "imageUrl": "https://example.com/sugar.png",
      "unit": "kg"
    },
    "price": 5,
    "inStock": true,
    "createdAt": "2026-07-12T13:00:00.000Z",
    "updatedAt": "2026-07-12T13:00:00.000Z",
    "__v": 0
  }
}
```

**Errors**
- `400` — invalid shop id, validation, `{ "error": "Invalid product id" }`, or `{ "error": "Product not found" }`
- `401` — not logged in
- `403` — `{ "error": "Forbidden" }` (seller adding to a shop that isn't theirs)
- `404` — `{ "error": "Shop not found" }`
- `409` — `{ "error": "This shop already lists this product — update it instead" }`

---

### `PATCH /api/listings/:id`
**Auth:** seller (owner of the listing's shop) or admin.

Changes **only** `price` and/or `inStock`. You cannot repoint a listing at a
different shop or product (those fields are ignored) — delete and recreate instead.

**Body** — both optional: `price` (number ≥ 0), `inStock` (boolean).

**Example request**
```json
{ "price": 4.5 }
```

**200** — returns the listing with `product` populated (same shape as create).

**Errors**
- `400` — `{ "error": "Invalid listing id" }` or validation
- `401` / `403`
- `404` — `{ "error": "Listing not found" }`

---

### `DELETE /api/listings/:id`
**Auth:** seller (owner) or admin.

Removes the listing entirely — how a shop stops offering a product.

**200**
```json
{ "message": "Listing deleted" }
```

**Errors**
- `400` — `{ "error": "Invalid listing id" }`
- `401` / `403`
- `404` — `{ "error": "Listing not found" }`

---

### `GET /api/shops/:shopId/products`
**Auth:** public.

Every listing for one shop (the Store Profile product list), newest first. Each
listing carries its own `price`/`inStock` and a populated `product`. The shop must
be active (inactive → 404).

**200**
```json
{
  "listings": [
    {
      "_id": "665fcc11dd22ee33ff4400aa",
      "shop": "665f77aa88bb99cc00dd11ee",
      "product": {
        "_id": "665faa11bb22cc33dd44ee55",
        "name": "White Sugar 1kg",
        "nameAr": "سكر أبيض 1كغ",
        "imageUrl": "https://example.com/sugar.png",
        "unit": "kg",
        "category": "665f00aa11bb22cc33dd44ee"
      },
      "price": 5,
      "inStock": true,
      "createdAt": "2026-07-12T13:00:00.000Z",
      "updatedAt": "2026-07-12T13:00:00.000Z"
    }
  ]
}
```

A shop with no listings returns `{ "listings": [] }`.

**Errors**
- `400` — `{ "error": "Invalid shop id" }`
- `404` — `{ "error": "Shop not found" }` (missing or inactive)

---

## Reviews

A review is one customer's star rating (+ optional comment) for **a shop**. Each
customer can review a given shop **at most once**. Every write recomputes that
shop's cached `ratingAvg`/`ratingCount`.

### `POST /api/shops/:shopId/reviews`
**Auth:** **customer** only.

Leave a review for a shop. `author` comes from your token; `shop` from the URL.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `rating` | number | ✅ | Whole number 1–5 |
| `comment` | string | ❌ | |

**Example request**
```json
{ "rating": 5, "comment": "Fast and friendly." }
```

**201** — `author` and `shop` are bare ids:
```json
{
  "review": {
    "_id": "665fdd11ee22ff3300445566",
    "author": "665f1a2b3c4d5e6f70819a2b",
    "shop": "665f77aa88bb99cc00dd11ee",
    "rating": 5,
    "comment": "Fast and friendly.",
    "createdAt": "2026-07-12T14:00:00.000Z",
    "updatedAt": "2026-07-12T14:00:00.000Z",
    "__v": 0
  }
}
```

**Errors**
- `400` — invalid shop id, or validation (e.g. `{ "error": "Rating must be at most 5" }`)
- `401` — not logged in
- `403` — `{ "error": "Forbidden" }` (only customers may review)
- `404` — `{ "error": "Shop not found" }` (missing or inactive)
- `409` — `{ "error": "You have already reviewed this shop" }`

---

### `GET /api/shops/:shopId/reviews`
**Auth:** public. **Paginated.**

A shop's reviews, newest first. `author` is populated to **name only** — no
credentials leak.

**Query:** `?page=`, `?limit=` (default 20, max 50).

**200**
```json
{
  "reviews": [
    {
      "_id": "665fdd11ee22ff3300445566",
      "author": { "_id": "665f1a2b3c4d5e6f70819a2b", "name": "Sara Ahmed" },
      "shop": "665f77aa88bb99cc00dd11ee",
      "rating": 5,
      "comment": "Fast and friendly.",
      "createdAt": "2026-07-12T14:00:00.000Z",
      "updatedAt": "2026-07-12T14:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 12
}
```

**Errors**
- `400` — `{ "error": "Invalid shop id" }`
- `404` — `{ "error": "Shop not found" }`

---

### `PATCH /api/reviews/:id`
**Auth:** logged-in user, but **only the review's author** may edit.

Change `rating` and/or `comment`. Re-syncs the shop rating afterward.

**Body** — both optional: `rating` (int 1–5), `comment` (string).

**Example request**
```json
{ "rating": 4 }
```

**200** — `author`/`shop` come back as ids:
```json
{
  "review": {
    "_id": "665fdd11ee22ff3300445566",
    "author": "665f1a2b3c4d5e6f70819a2b",
    "shop": "665f77aa88bb99cc00dd11ee",
    "rating": 4,
    "comment": "Fast and friendly.",
    "createdAt": "2026-07-12T14:00:00.000Z",
    "updatedAt": "2026-07-12T14:20:00.000Z"
  }
}
```

**Errors**
- `400` — `{ "error": "Invalid review id" }` or validation
- `401` — not logged in
- `403` — `{ "error": "Forbidden" }` (not the author; no admin override on edit)
- `404` — `{ "error": "Review not found" }`

---

### `DELETE /api/reviews/:id`
**Auth:** logged-in user — the **author** may delete their own; an **admin** may
delete anyone's. Re-syncs the shop rating (deleting the last review resets it to
`0`/`0`).

**200**
```json
{ "message": "Review deleted" }
```

**Errors**
- `400` — `{ "error": "Invalid review id" }`
- `401` — not logged in
- `403` — `{ "error": "Forbidden" }` (not the author and not an admin)
- `404` — `{ "error": "Review not found" }`

---

## Cart

Every cart route is **customer only** and always resolves to *your own* cart from
your token — there's no cart id in any URL. A cart item points at a **listing**
(so it knows the shop and the live price), and a cart may mix items from several
shops. The cart **never stores a price** — reads populate the current price fresh.
An item is identified by its **listing id** (items have no id of their own; a
listing appears at most once per cart).

**The populated cart shape** (returned by every cart endpoint):
```json
{
  "cart": {
    "_id": "665fee11ff2200334455aabb",
    "customer": "665f1a2b3c4d5e6f70819a2b",
    "items": [
      {
        "listing": {
          "_id": "665fcc11dd22ee33ff4400aa",
          "price": 5,
          "inStock": true,
          "shop": { "_id": "665f77aa88bb99cc00dd11ee", "name": "Abu Ali Store", "area": "Rimal", "phone": "0599000111" },
          "product": { "_id": "665faa11bb22cc33dd44ee55", "name": "White Sugar 1kg", "nameAr": "سكر أبيض 1كغ", "imageUrl": "https://example.com/sugar.png", "unit": "kg" }
        },
        "quantity": 2
      }
    ],
    "createdAt": "2026-07-12T15:00:00.000Z",
    "updatedAt": "2026-07-12T15:05:00.000Z"
  }
}
```

Before a customer has ever added anything, the cart endpoints return the empty
shape **`{ "cart": { "items": [] } }`** (a `200`, never a `404`).

### `GET /api/cart`
**Auth:** customer.

Returns your populated cart (or the empty shape if you have none yet).

**200** — see "populated cart shape" above.

**Errors:** `401` / `403`.

---

### `POST /api/cart/items`
**Auth:** customer.

Adds a listing to your cart. If the listing is **already** in the cart, its
quantity is **incremented** by `quantity` (POST *adds*; PATCH *sets*). Creates the
cart on first use.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `listing` | string (id) | ✅ | Must be a real listing |
| `quantity` | number | ❌ | Whole number ≥ 1; defaults to `1` |

**Example request**
```json
{ "listing": "665fcc11dd22ee33ff4400aa", "quantity": 2 }
```

**201** — the full populated cart (see shape above).

**Errors**
- `400` — validation, `{ "error": "Invalid listing id" }`, or `{ "error": "Listing not found" }`
- `401` / `403`

---

### `PATCH /api/cart/items/:listingId`
**Auth:** customer.

**Sets** one item's quantity to an exact value (contrast POST, which adds). The URL
param is the **listing id**.

**Body**

| Field | Type | Required | Notes |
| ----- | ---- | -------- | ----- |
| `quantity` | number | ✅ | Whole number ≥ 1 |

**Example request**
```json
{ "quantity": 3 }
```

**200** — the full populated cart.

**Errors**
- `400` — `{ "error": "Invalid listing id" }` or validation
- `401` / `403`
- `404` — `{ "error": "Item not in cart" }`

---

### `DELETE /api/cart/items/:listingId`
**Auth:** customer.

Removes one item. **Idempotent** — removing something already gone (or from a
customer with no cart) still returns `200`.

**200** — the full populated cart (or `{ "cart": { "items": [] } }`).

**Errors**
- `400` — `{ "error": "Invalid listing id" }`
- `401` / `403`

---

### `DELETE /api/cart`
**Auth:** customer.

Empties the whole cart (`items → []`). Safe to call even with no cart.

**200**
```json
{ "cart": { "items": [] } }
```

(If a cart already existed, you get the full populated cart with an empty `items`
array.)

**Errors:** `401` / `403`.

---

## Home

### `GET /api/home`
**Auth:** public.

One request that bundles the three Home-page strips, so the frontend does a single
round-trip. Each list is capped at **8**. `featured` and `newArrivals` are arrays
of **products** (category populated to `{ _id, name, nameAr }`); `topStores` is an
array of **shops** (safe public fields, same shape as `GET /api/shops/top`).
`featured` uses the same empty→newest fallback as `/api/products/featured`.

**200**
```json
{
  "featured": [
    {
      "_id": "665faa11bb22cc33dd44ee55",
      "name": "White Sugar 1kg",
      "nameAr": "سكر أبيض 1كغ",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "unit": "kg",
      "imageUrl": "https://example.com/sugar.png",
      "isFeatured": true,
      "createdAt": "2026-07-05T08:00:00.000Z",
      "updatedAt": "2026-07-05T08:00:00.000Z"
    }
  ],
  "newArrivals": [
    {
      "_id": "665fbb22cc33dd44ee5566ff",
      "name": "Olive Oil 1L",
      "nameAr": "زيت زيتون 1ل",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "unit": "L",
      "isFeatured": false,
      "createdAt": "2026-07-11T08:00:00.000Z",
      "updatedAt": "2026-07-11T08:00:00.000Z"
    }
  ],
  "topStores": [
    {
      "_id": "665f77aa88bb99cc00dd11ee",
      "name": "Abu Ali Store",
      "area": "Rimal",
      "phone": "0599000111",
      "logoUrl": "https://example.com/logo.png",
      "category": { "_id": "665f00aa11bb22cc33dd44ee", "name": "Groceries", "nameAr": "بقالة" },
      "ratingAvg": 4.7,
      "ratingCount": 12,
      "isVerified": true,
      "createdAt": "2026-06-10T09:00:00.000Z"
    }
  ]
}
```

---

## Quick reference — every endpoint

| Method & path | Auth | Notes |
| ------------- | ---- | ----- |
| `GET /api/health` | public | Liveness |
| `POST /api/auth/register` | public | → `{ user }` (201) |
| `POST /api/auth/login` | public | → `{ token }` |
| `GET /api/auth/me` | any user | → `{ user }` |
| `GET /api/categories` | public | → `{ categories }` |
| `GET /api/categories/:id` | public | → `{ category }` |
| `GET /api/shops` | public | active only → `{ shops }` |
| `GET /api/shops/top` | public | capped `?limit` → `{ shops }` |
| `GET /api/shops/:id` | public | → `{ shop }` |
| `POST /api/shops` | seller/admin | → `{ shop }` (201) |
| `PATCH /api/shops/:id` | seller(own)/admin | → `{ shop }` |
| `GET /api/products` | public | **paginated** → `{ products, page, limit, total }` |
| `GET /api/products/search` | public | **paginated**, `?q&category&sort` |
| `GET /api/products/featured` | public | capped `?limit` → `{ products }` |
| `GET /api/products/new` | public | **paginated** → `{ products, page, limit, total }` |
| `GET /api/products/:id` | public | → `{ product }` |
| `GET /api/products/:id/listings` | public | price comparison → `{ product, listings }` |
| `POST /api/products` | seller/admin | → `{ product }` (201) |
| `PATCH /api/products/:id/feature` | admin | body `{ isFeatured }` → `{ product }` |
| `POST /api/shops/:shopId/listings` | seller(own)/admin | → `{ listing }` (201) |
| `PATCH /api/listings/:id` | seller(own)/admin | price/inStock → `{ listing }` |
| `DELETE /api/listings/:id` | seller(own)/admin | → `{ message }` |
| `GET /api/shops/:shopId/products` | public | → `{ listings }` |
| `POST /api/shops/:shopId/reviews` | customer | → `{ review }` (201) |
| `GET /api/shops/:shopId/reviews` | public | **paginated** → `{ reviews, page, limit, total }` |
| `PATCH /api/reviews/:id` | author | → `{ review }` |
| `DELETE /api/reviews/:id` | author/admin | → `{ message }` |
| `GET /api/cart` | customer | → `{ cart }` |
| `POST /api/cart/items` | customer | body `{ listing, quantity? }` → `{ cart }` (201) |
| `PATCH /api/cart/items/:listingId` | customer | body `{ quantity }` → `{ cart }` |
| `DELETE /api/cart/items/:listingId` | customer | idempotent → `{ cart }` |
| `DELETE /api/cart` | customer | empty cart → `{ cart }` |
| `GET /api/home` | public | → `{ featured, newArrivals, topStores }` |
