// Shared query helpers for the Home page (Step 10).
//
// Why this file exists: the Home page shows three lists — featured products, new
// arrivals, and top stores — and we expose them BOTH as three separate endpoints
// AND bundled together in `GET /api/home`. If each place wrote its own query, they
// could slowly drift apart (e.g. `/api/home`'s "new arrivals" sorting differently
// from `/api/products/new`). To prevent that, the ONE canonical query for each
// section lives here as a small function. Every endpoint calls these, so they can
// never disagree.
//
// Each function returns a plain array of documents — no `req`/`res`, no HTTP. The
// controllers stay in charge of reading query params and shaping the JSON reply.

const Product = require("../models/Product");

// The Home lists are short, capped lists (not full pagination). This turns a raw
// ?limit into a trustworthy number: default to `def` when it's missing/garbage,
// and never allow more than MAX (so a caller can't ask for 10,000 at once). Same
// "fix it, don't error" spirit as utils/pagination.js.
const MAX_LIMIT = 50;
function clampLimit(query, def) {
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = def;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  return limit;
}

// New arrivals = the newest products, newest first. `skip` lets the paginated
// `/api/products/new` endpoint page through them; the bundled `/api/home` just
// asks for the first `limit` (skip defaults to 0). We populate the category down
// to name/nameAr only — the same public projection every other product read uses.
function getNewArrivals({ limit, skip = 0 }) {
  return Product.find({})
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("category", "name nameAr");
}

// Featured products = the ones an admin has flagged (isFeatured: true), newest
// first, capped at `limit`.
//
// IMPORTANT fallback: before any product has been featured, this query returns an
// empty list — which would leave the homepage's "featured offers" strip blank. So
// if nothing is flagged yet, we fall back to the newest products instead. The
// homepage is therefore never empty, and it "upgrades" to real featured picks the
// moment an admin flags some. Because this is async, we await the featured query,
// then decide whether to fall back.
async function getFeaturedProducts({ limit }) {
  const featured = await Product.find({ isFeatured: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("category", "name nameAr");

  if (featured.length > 0) return featured;

  // Fallback: nothing flagged yet → show newest products so the strip isn't blank.
  return getNewArrivals({ limit });
}

module.exports = { clampLimit, getNewArrivals, getFeaturedProducts };
