const mongoose = require("mongoose");
const { z } = require("zod");
const Listing = require("../models/Listing");
const Shop = require("../models/Shop");
const Product = require("../models/Product");

// --- Input validation ---------------------------------------------------
// A WHITELIST for creating a listing. The shop comes from the URL (:shopId), not
// the body, so it's NOT here. Only these three keys are accepted; anything else
// is stripped. price must be a JSON number (not "5" as a string) and can't be
// negative; inStock is optional and falls back to the model's default (true).
const createListingSchema = z.object({
  product: z.string().min(1, "Product is required"),
  price: z.number().min(0, "Price cannot be negative"),
  inStock: z.boolean().optional(),
});

// POST /api/shops/:shopId/listings
// Protected: a logged-in seller or admin (auth + requireRole run first, in the
// route). A seller may add a listing only to their OWN shop; an admin may add to
// any shop. Creates one price for one product in one shop.
async function createListing(req, res, next) {
  // 1. Guard the shop id from the URL FIRST (else findById would throw a
  //    CastError on junk like "abc"). A malformed URL id is a 400.
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Load the shop. A well-formed id that matches nothing is a 404 — the id
  //    is in the URL PATH, so "no such shop" means "that route points at
  //    nothing." We do NOT filter by isActive: an owner should be able to price
  //    products even in a shop that's currently hidden (same as updateShop).
  const shop = await Shop.findById(req.params.shopId);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Ownership check. Admins skip it. For a seller, the shop's owner id must
  //    equal their own id (owner is an ObjectId, so .toString() to compare it to
  //    the string id from the token). If not, 403 — they're logged in, but it
  //    isn't their shop.
  if (req.user.role !== "admin" && shop.owner.toString() !== req.user.id) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body against the whitelist.
  const result = createListingSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. Make sure the product is real. Malformed id → 400 "Invalid product id";
  //    well-formed but no such product → 400 "Product not found" (the id came in
  //    the BODY as data the caller supplied, so a bad one is their mistake).
  if (!mongoose.Types.ObjectId.isValid(data.product)) {
    return next({ status: 400, message: "Invalid product id" });
  }
  const product = await Product.findById(data.product);
  if (!product) {
    return next({ status: 400, message: "Product not found" });
  }

  // 6. Create the listing. shop comes from the verified URL, product/price/
  //    inStock from the validated body (inStock undefined → model default true).
  //    The unique (shop, product) index means a SECOND listing for the same pair
  //    is rejected by MongoDB with error code 11000. We catch exactly that and
  //    turn it into a friendly 409 Conflict; any other error is forwarded to the
  //    central handler (a 500).
  try {
    const listing = await Listing.create({
      shop: req.params.shopId,
      product: data.product,
      price: data.price,
      inStock: data.inStock,
    });

    // Populate the product before replying, so the response shows what was
    // listed (name, price…) instead of a bare id. Then respond 201 (Created).
    await listing.populate("product", "name nameAr imageUrl unit");
    res.status(201).json({ listing });
  } catch (err) {
    if (err.code === 11000) {
      return next({
        status: 409,
        message:
          "This shop already lists this product — update it instead",
      });
    }
    return next(err);
  }
}

module.exports = { createListing };
