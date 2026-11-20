const mongoose = require("mongoose");
const { z } = require("zod");
const Listing = require("../models/Listing");
const Shop = require("../models/Shop");
const Product = require("../models/Product");
const parsePagination = require("../utils/pagination");
const parseBooleanQuery = require("../utils/booleanQuery");
const {
  shopFilter,
  staleFilter,
  MIN_STALE_DAYS,
  MAX_STALE_DAYS,
} = require("../utils/sellerQueries");

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
      // A brand-new price was just entered, so it's confirmed as of now.
      priceConfirmedAt: new Date(),
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

  // Sending a price at all means "I've checked this price", even when it's the
  // same number as before. That counts as a confirmation. A PATCH with only
  // `inStock` says nothing about the price, so it doesn't.
  if (data.price !== undefined) {
    listing.priceConfirmedAt = new Date();
  }
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

// GET /api/shops/:shopId/products
// Public. Returns every listing for one shop, each with its product's details
// attached — this powers the Store Profile page's product list. It's the mirror
// image of the comparison query (which fixes a product and gathers shops); here
// we fix a shop and gather its products.
async function listShopProducts(req, res, next) {
  // 1. Guard the shop id from the URL (else find throws a CastError on junk).
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Make sure the shop exists AND is visible. We hide inactive shops with a
  //    404 exactly like the public getShop does — this endpoint feeds the same
  //    public Store Profile page, so its visibility rules must match (we don't
  //    reveal a hidden shop by leaking its product list).
  const shop = await Shop.findById(req.params.shopId);
  if (!shop || !shop.isActive) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Fetch this shop's listings, newest first, and swap each product id for a
  //    slim slice of the product (the fields the profile card needs). Each
  //    listing already carries its own price and inStock. A shop with no
  //    listings simply gives back [] — an empty list is a valid answer (200).
  const listings = await Listing.find({ shop: req.params.shopId })
    .sort({ createdAt: -1 })
    .populate("product", "name nameAr imageUrl unit category");

  res.json({ listings });
}

// GET /api/products/:id/listings
// Public. THE headline feature: given one product, return every shop's price for
// it, CHEAPEST FIRST. This is the mirror of listShopProducts — that one fixes a
// shop and lists its products; this one fixes a product and lists the shops
// selling it, so a shopper can compare prices at a glance.
async function listProductListings(req, res, next) {
  // 1. Guard the id, then confirm the product exists (so we can 404 clearly and
  //    include the product's own details in the response).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }
  const product = await Product.findById(req.params.id);
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  // 2. Find every listing for this product, sorted by price ascending (cheapest
  //    first) AT THE DATABASE LEVEL, and pull in each listing's shop — but only
  //    the safe public fields. We also grab isActive purely so we can filter on
  //    it next; it never goes into the response. The shop OWNER is never even
  //    loaded, so there's no way to leak their email/credentials.
  const listings = await Listing.find({ product: req.params.id })
    .sort({ price: 1 })
    .populate("shop", "name area phone ratingAvg ratingCount isVerified isActive");

  // 3. Keep only listings whose shop is still active (hide prices from
  //    deactivated shops), and — importantly — a listing whose shop was deleted
  //    populates as null, so `l.shop &&` drops those too. Filtering preserves the
  //    cheapest-first order the DB already gave us. Then reshape each listing to
  //    expose exactly the safe fields (no isActive, no owner).
  const activeListings = listings
    .filter((l) => l.shop && l.shop.isActive)
    .map((l) => ({
      _id: l._id,
      price: l.price,
      inStock: l.inStock,
      // When the shop last confirmed this price, so the app can say "price
      // checked 2 days ago". null = never confirmed (an older listing).
      priceConfirmedAt: l.priceConfirmedAt,
      shop: {
        _id: l.shop._id,
        name: l.shop.name,
        area: l.shop.area,
        phone: l.shop.phone,
        ratingAvg: l.shop.ratingAvg,
        ratingCount: l.shop.ratingCount,
        // The admin-given "verified" badge, so customers comparing prices can
        // see which shops an admin has checked.
        isVerified: l.shop.isVerified,
      },
    }));

  // 4. Respond with the product summary + the cheapest-first listings. No shop
  //    lists it (or all lister-shops are inactive) → listings: [] with 200.
  res.json({
    product: {
      _id: product._id,
      name: product.name,
      nameAr: product.nameAr,
      imageUrl: product.imageUrl,
      unit: product.unit,
    },
    listings: activeListings,
  });
}

// GET /api/seller/listings   (seller: items of MY shops)
// GET /api/admin/listings    (admin: items of EVERY shop)
// One function, two dashboards. shopFilter() decides which shops count: all of
// a seller's own shops, or every shop in the marketplace for an admin. So the
// seller and the admin can never see items in two different ways.
//
// Newest first, paginated, and it includes the items of CLOSED and LOCKED
// shops: the public item list (GET /api/shops/:shopId/products) answers 404 for
// those, but the seller and the admin both need to see them.
//
// Optional filters (they combine):
//   ?shop=<id>             one shop only (a seller: one of MINE, else 403)
//   ?inStock=true|false    only items in stock / out of stock
//   ?staleDays=<1..60>     only OLD prices: not confirmed in that many days, or
//                          never. Sorted OLDEST first (never-confirmed at the top),
//                          so the most out-of-date prices are seen first.
async function listDashboardListings(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  // Seller: { shop: { $in: myShopIds } }. Admin: {} (every shop).
  // Either: { shop: id } for ?shop=.
  const { problem, filter } = await shopFilter(req.user, req.query.shop);
  if (problem) {
    return next(problem);
  }

  // ?inStock=true|false. The text "false" must become the boolean false, and a
  // typo is a 400 (see utils/booleanQuery.js).
  const inStock = parseBooleanQuery(req.query.inStock, "inStock");
  if (inStock.problem) {
    return next(inStock.problem);
  }
  if (inStock.value !== undefined) {
    filter.inStock = inStock.value;
  }

  // Newest first by default. For the old-prices view: oldest confirmation first.
  let sort = { createdAt: -1, _id: -1 };

  if (req.query.staleDays) {
    // Number("2.5") is 2.5 and Number("abc") is NaN, and isInteger rejects both.
    // (parseInt would quietly turn "2.5" into 2.)
    const days = Number(req.query.staleDays);
    if (!Number.isInteger(days) || days < MIN_STALE_DAYS || days > MAX_STALE_DAYS) {
      return next({
        status: 400,
        message: `staleDays must be a whole number from ${MIN_STALE_DAYS} to ${MAX_STALE_DAYS}`,
      });
    }
    // Adds the { $or: [...] } condition next to `shop` and `inStock`. MongoDB
    // treats every key of a filter as AND: mine, AND in stock, AND old.
    Object.assign(filter, staleFilter(days));
    // In an ascending sort MongoDB puts null (never confirmed) before any date,
    // which is exactly the order we want.
    sort = { priceConfirmedAt: 1, _id: 1 };
  }

  const [listings, total] = await Promise.all([
    Listing.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate("product", "name nameAr imageUrl unit category")
      // The shop's name so items of different shops can be told apart, and
      // isActive so the dashboard can mark items of a closed shop.
      .populate("shop", "name isActive"),
    Listing.countDocuments(filter),
  ]);

  res.json({ listings, page, limit, total });
}

module.exports = {
  listDashboardListings,
  createListing,
  updateListing,
  deleteListing,
  listShopProducts,
  listProductListings,
};
