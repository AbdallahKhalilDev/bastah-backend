const mongoose = require("mongoose");
const { z } = require("zod");
const Product = require("../models/Product");
const Category = require("../models/Category");
const parsePagination = require("../utils/pagination");

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

module.exports = { createProduct, listProducts, getProduct };
