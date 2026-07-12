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

// A WHITELIST for updating a listing. Notice what's NOT here: shop and product.
// You may change ONLY the price and whether it's in stock. Both are optional so
// a PATCH changes just the fields you send. (Why shop/product are forbidden is
// explained on updateListing below.)
const updateListingSchema = z.object({
  price: z.number().min(0, "Price cannot be negative").optional(),
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

// PATCH /api/listings/:id
// Protected: a logged-in seller or admin (auth + requireRole run first). The
// seller who owns the listing's shop may edit it; an admin may edit any. You can
// change ONLY price and inStock.
async function updateListing(req, res, next) {
  // 1. Guard the id from the URL (else findById throws a CastError on junk).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid listing id" });
  }

  // 2. Load the listing. A well-formed id matching nothing is a 404.
  const listing = await Listing.findById(req.params.id);
  if (!listing) {
    return next({ status: 404, message: "Listing not found" });
  }

  // 3. Ownership. A listing doesn't store its owner directly — it points at a
  //    shop, and the SHOP knows its owner. So we load the shop and compare. An
  //    admin skips this. (The `!shop` guard covers the rare orphan case where a
  //    listing's shop was deleted: then only an admin may touch it.)
  const shop = await Shop.findById(listing.shop);
  if (
    req.user.role !== "admin" &&
    (!shop || shop.owner.toString() !== req.user.id)
  ) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body against the update whitelist. Because shop and product
  //    are NOT in the whitelist, zod strips them: even if the client sends a new
  //    shop/product, we ignore it. WHY we forbid changing them: this listing is
  //    "shop X's price for product Y." Silently repointing it at a different
  //    product or shop would move a real price onto the wrong item and corrupt
  //    the comparison data. To "move" a listing you delete it and create a new
  //    one — an explicit action, not an accidental side effect of an edit.
  const result = updateListingSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. Copy the validated fields onto the document and save. save() runs the
  //    schema validators and refreshes the updatedAt timestamp.
  Object.assign(listing, data);
  await listing.save();

  await listing.populate("product", "name nameAr imageUrl unit");
  res.json({ listing });
}

// DELETE /api/listings/:id
// Same permissions as updateListing. Removes the listing entirely — this is how
// a shop stops offering a product (and the correct way to "move" a listing:
// delete, then create a fresh one for the right shop/product).
async function deleteListing(req, res, next) {
  // Same id guard → load → ownership check as updateListing.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid listing id" });
  }

  const listing = await Listing.findById(req.params.id);
  if (!listing) {
    return next({ status: 404, message: "Listing not found" });
  }

  const shop = await Shop.findById(listing.shop);
  if (
    req.user.role !== "admin" &&
    (!shop || shop.owner.toString() !== req.user.id)
  ) {
    return next({ status: 403, message: "Forbidden" });
  }

  // Delete this document, then confirm. We return a small JSON message (200)
  // rather than an empty 204 so the response is clear when testing.
  await listing.deleteOne();
  res.json({ message: "Listing deleted" });
}

module.exports = { createListing, updateListing, deleteListing };
