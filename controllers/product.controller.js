const mongoose = require("mongoose");
const { z } = require("zod");
const Product = require("../models/Product");
const Category = require("../models/Category");
const parsePagination = require("../utils/pagination");
const homeQueries = require("../utils/homeQueries");

// --- Input validation ---------------------------------------------------
// zod describes exactly what a valid "create product" body looks like. It is a
// WHITELIST: only these keys are accepted. By default zod *strips* any other key
// it doesn't know about, so if a client sneaks in something unexpected it's
// silently dropped and can never reach the database. name/nameAr/category are
// the required ones; description/unit/imageUrl are optional extras.
const createProductSchema = z.object({
  name: z.string().min(1, "Name is required"),
  nameAr: z.string().min(1, "Arabic name is required"),
  description: z.string().optional(),
  category: z.string().min(1, "Category is required"),
  unit: z.string().optional(),
  imageUrl: z.string().optional(),
});

// The body for the admin-only "feature / un-feature" route. It's a single
// required boolean: `true` promotes the product to the Home page, `false` removes
// it. We take an EXPLICIT value (rather than blindly toggling) so the call is
// idempotent — sending { isFeatured: true } twice leaves the product featured,
// with no surprise flip.
const setFeaturedSchema = z.object({
  isFeatured: z.boolean(),
});

// POST /api/products
// Protected: only a logged-in seller or admin reaches here (auth + requireRole
// run first, in the route). Creates a canonical catalog product that any shop
// can later attach a price to via a Listing.
async function createProduct(req, res, next) {
  // 1. Validate the body against the whitelist. safeParse doesn't throw — it
  //    returns success/error so we can craft our own readable 400 from the
  //    first problem it found.
  const result = createProductSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. category is REQUIRED for a product, and it must point at a real Category.
  //    First check the id is well-formed (else Mongoose would throw a CastError),
  //    then that a Category with that id actually exists. Because category here
  //    arrives in the request BODY (data the caller supplied), a bad or missing
  //    one is the caller's mistake → 400, the same way createShop treats it.
  if (!mongoose.Types.ObjectId.isValid(data.category)) {
    return next({ status: 400, message: "Invalid category id" });
  }
  const category = await Category.findById(data.category);
  if (!category) {
    return next({ status: 400, message: "Category not found" });
  }

  // 3. Create the product. Only whitelisted keys are in `data`, so nothing
  //    unexpected can slip into the document.
  const product = await Product.create(data);

  // 4. Populate the category before replying, so the response shows the full
  //    category document (name, nameAr…) instead of just its id — handy when
  //    testing, and what the frontend wants anyway. Then respond 201 (Created).
  await product.populate("category");
  res.status(201).json({ product });
}

// GET /api/products
// Public. Returns the catalog, newest first, in PAGES. A catalog can grow to
// thousands of items, so we never send them all at once — the caller asks for a
// "page" of a given "limit" size, and we also tell them the grand `total` so a
// frontend can show "page 1 of N".
async function listProducts(req, res, next) {
  // Turn ?page / ?limit into trustworthy numbers (+ the skip offset).
  const { page, limit, skip } = parsePagination(req.query);

  // countDocuments is a separate, cheap query that returns HOW MANY products
  // match — here, all of them. It's the total across every page, not just this
  // one, so the frontend knows how many pages exist.
  const total = await Product.countDocuments({});

  // The actual page: sort newest-first, jump over `skip` docs, take `limit`.
  // populate swaps each category id for just its name/nameAr (nothing else).
  const products = await Product.find({})
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("category", "name nameAr");

  res.json({ products, page, limit, total });
}

// GET /api/products/:id
// Public. Returns a single product by its id, with its category populated.
async function getProduct(req, res, next) {
  // 1. Guard the id FIRST (else findById throws a CastError on junk like "abc").
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }

  // 2. Look it up. A well-formed id matching nothing → 404.
  const product = await Product.findById(req.params.id).populate(
    "category",
    "name nameAr"
  );
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  res.json({ product });
}

// Escapes regex special characters in user input so we can safely build a regex
// from it. Without this, a search for "(" would be an INVALID regex and throw a
// 500 — and a crafted input could make the regex do surprising things. This
// turns every special char (. * + ? ( ) [ ] etc.) into a plain literal.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/products/search
// Public. Search the catalog by text, optionally filter by category, choose a
// sort, and page the results. Every param is OPTIONAL: with no params it behaves
// just like the browse list. We validate defensively — a bad category id is a
// 400, but an unknown sort value simply falls back to the default (never a crash).
async function searchProducts(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  // We build up a MongoDB "filter" object piece by piece. An empty {} matches
  // everything; each param we're given adds another condition to narrow it.
  const filter = {};

  // q — case-insensitive PARTIAL text match on name OR nameAr. We use a regex:
  // new RegExp("sug", "i") matches "Sugar", "sugar cane", etc. ($or = "either
  // field can match"). Approach note: a regex is the simple way to match a
  // substring as the user types; a MongoDB text index would scale better on a
  // huge catalog but only matches whole words, so regex fits this MVP.
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { nameAr: rx }];
  }

  // category — filter to one category. It's a real id the caller supplied, so a
  // malformed one is their mistake → 400 (same rule as everywhere else).
  if (req.query.category) {
    if (!mongoose.Types.ObjectId.isValid(req.query.category)) {
      return next({ status: 400, message: "Invalid category id" });
    }
    filter.category = req.query.category;
  }

  // sort — a small whitelist. "name" sorts A→Z; anything else (including
  // "newest", an unknown value, or nothing) falls back to newest-first. An
  // unexpected value never errors, it just uses the default.
  const sort = req.query.sort === "name" ? { name: 1 } : { createdAt: -1 };

  // Same paginated shape as the browse list.
  const total = await Product.countDocuments(filter);
  const products = await Product.find(filter)
    .sort(sort)
    .skip(skip)
    .limit(limit)
    .populate("category", "name nameAr");

  res.json({ products, page, limit, total });
}

// GET /api/products/featured
// Public. The Home page's "featured offers" strip: products an admin has flagged
// (isFeatured: true), newest first, capped by ?limit (default 10). The empty →
// newest fallback lives in the helper, so this handler stays tiny: it never
// returns an empty list while there ARE products in the catalog. This is a small,
// fixed-size list, not a paged one, so we reply with just { products }.
async function getFeaturedProducts(req, res, next) {
  const limit = homeQueries.clampLimit(req.query, 10);
  const products = await homeQueries.getFeaturedProducts({ limit });
  res.json({ products });
}

// GET /api/products/new
// Public. "New arrivals" — the newest products by createdAt. Unlike /featured,
// this one KEEPS full pagination (page/limit/skip + a total count), reusing the
// same parsePagination helper and the same { products, page, limit, total } shape
// as the main browse list, so a frontend can page through everything new.
async function getNewArrivals(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const total = await Product.countDocuments({});
  const products = await homeQueries.getNewArrivals({ limit, skip });
  res.json({ products, page, limit, total });
}

// PATCH /api/products/:id/feature
// Admin only (auth + requireRole("admin") run first, in the route). Featuring is
// an EDITORIAL decision — like verifying a shop — so a seller must never be able
// to do it. We keep this on its own admin-gated route instead of adding
// `isFeatured` to the create/update whitelist, which would let any seller flag
// their own product. Body: { isFeatured: true|false }.
async function setFeatured(req, res, next) {
  // 1. Validate the body: exactly one required boolean. safeParse gives us a
  //    readable 400 instead of throwing.
  const result = setFeaturedSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. Guard the id FIRST (else findById throws a CastError on junk like "abc").
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }

  // 3. Load the product. A well-formed id matching nothing → 404.
  const product = await Product.findById(req.params.id);
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  // 4. Set the flag to the requested value (not a toggle — idempotent), save, and
  //    return the product with its category populated like the other reads.
  product.isFeatured = data.isFeatured;
  await product.save();
  await product.populate("category", "name nameAr");
  res.json({ product });
}

module.exports = {
  createProduct,
  listProducts,
  getProduct,
  searchProducts,
  getFeaturedProducts,
  getNewArrivals,
  setFeatured,
};
