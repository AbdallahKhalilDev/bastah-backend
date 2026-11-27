const mongoose = require("mongoose");
const { z } = require("zod");
const Product = require("../models/Product");
const parsePagination = require("../utils/pagination");
const homeQueries = require("../utils/homeQueries");
const escapeRegex = require("../utils/escapeRegex");
const { checkCategory } = require("../utils/shopRules");

// --- Input validation ---------------------------------------------------
// The product field rules live in utils/productRules.js, shared by create and
// edit, so a product can't be valid in one and invalid in the other. They are
// WHITELISTS: zod drops any key it doesn't know, so a client can't set things
// it shouldn't.
// imageUrl is deliberately NOT in them: product images are files we manage on
// the server, so a new product gets the placeholder (the schema default) and
// `npm run seed:product-images` links its real photo later. If a client sends
// imageUrl anyway, zod strips it like any other unknown key.
const {
  VISIBLE_PRODUCT,
  createProductSchema,
  updateProductSchema,
  checkCanEditProduct,
} = require("../utils/productRules");

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

  // 2. category must point at a real Category: a well-formed id (else Mongoose
  //    would throw a CastError) of one that exists. It arrives in the request
  //    BODY, so a bad one is the caller's mistake → 400. The same shared check
  //    the shops use.
  const categoryProblem = await checkCategory(data.category);
  if (categoryProblem) {
    return next({ status: 400, message: categoryProblem });
  }

  // 3. Create the product. Only whitelisted keys are in `data`, so nothing
  //    unexpected can slip into the document. The creator comes from the
  //    verified token, never from the body: it decides who may edit it later.
  const product = await Product.create({ ...data, createdBy: req.user.id });

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
  // match — here, every product that isn't hidden. It's the total across every
  // page, not just this one, so the frontend knows how many pages exist.
  const total = await Product.countDocuments(VISIBLE_PRODUCT);

  // The actual page: sort newest-first, jump over `skip` docs, take `limit`.
  // populate swaps each category id for just its name/nameAr (nothing else).
  // `_id` breaks ties between products created in the same millisecond, so no
  // product is shown twice or skipped across pages (see utils/searchQueries.js).
  const products = await Product.find(VISIBLE_PRODUCT)
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .populate("category", "name nameAr");

  res.json({ products, page, limit, total });
}

// GET /api/products/:id
// Public. Returns a single product by its id, with its category populated.
// A product an admin hid is a 404, the same answer as one that doesn't exist.
async function getProduct(req, res, next) {
  // 1. Guard the id FIRST (else findById throws a CastError on junk like "abc").
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }

  // 2. Look it up: this id AND not hidden. Matching nothing → 404.
  const product = await Product.findOne({ _id: req.params.id, ...VISIBLE_PRODUCT }).populate(
    "category",
    "name nameAr"
  );
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  res.json({ product });
}

// GET /api/products/search
// Public. Search the catalog by text, optionally filter by category, choose a
// sort, and page the results. Every param is OPTIONAL: with no params it behaves
// just like the browse list. We validate defensively — a bad category id is a
// 400, but an unknown sort value simply falls back to the default (never a crash).
async function searchProducts(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  // We build up a MongoDB "filter" object piece by piece. It starts as "every
  // product that isn't hidden"; each param we're given adds another condition.
  const filter = { ...VISIBLE_PRODUCT };

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
  // Both end with `_id` as the tie-breaker, so pages never repeat or skip a
  // product that shares a name or a creation time (see utils/searchQueries.js).
  const sort = req.query.sort === "name" ? { name: 1, _id: 1 } : { createdAt: -1, _id: -1 };

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
  const total = await Product.countDocuments(VISIBLE_PRODUCT);
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

// PATCH /api/products/:id
// Protected: a logged-in seller or admin (auth + requireRole run first). Edits a
// catalog product's name, Arabic name, description, category or unit.
//
// WHO may edit is the rule in utils/productRules.js: an admin always; the
// seller who created it, only while no other seller's shop sells it.
//   not the creator               → 403
//   the creator, but it's shared  → 403 with code "product_shared", so the
//                                   dashboard can say "ask an admin"
// Same order as editing a shop: find it, check it's yours, then read the body.
async function updateProduct(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }

  // "+createdBy" asks for the field the schema hides from every other read
  // (select: false). The permission check needs it.
  const product = await Product.findById(req.params.id).select("+createdBy");
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  const notAllowed = await checkCanEditProduct(product, req.user);
  if (notAllowed) {
    return next(notAllowed);
  }

  const result = updateProductSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // Only when a category is sent (checkCategory passes on undefined). Keeping
  // the one it already has is fine, even if an admin hid that category since.
  const categoryProblem = await checkCategory(data.category, product.category);
  if (categoryProblem) {
    return next({ status: 400, message: categoryProblem });
  }

  // Only whitelisted keys are in `data`. Old orders are NOT affected by a
  // rename: each order line froze the product's name at checkout.
  Object.assign(product, data);
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
  updateProduct,
};
