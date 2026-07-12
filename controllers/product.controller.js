const mongoose = require("mongoose");
const { z } = require("zod");
const Product = require("../models/Product");
const Category = require("../models/Category");

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

module.exports = { createProduct };
