// The seller dashboard: "my shops", "these prices are still right" and the
// number cards. ("My items", GET /api/seller/listings, is shared with the admin
// dashboard, so it lives in listing.controller.js as listDashboardListings.)
//
// Every route here is seller-only. The check happens ONCE, at the top of
// routes/seller.routes.js (router.use), exactly like /api/admin.
//
// Actions that already have a home stay there: a seller still edits a shop with
// PATCH /api/shops/:id and a price with PATCH /api/listings/:id. This file only
// answers "show me what's mine", including the things customers can't see
// (closed shops and their items).
const mongoose = require("mongoose");
const { z } = require("zod");
const Shop = require("../models/Shop");
const Listing = require("../models/Listing");
const Product = require("../models/Product");
const parsePagination = require("../utils/pagination");
const { ZONE_POPULATE } = require("../utils/shopRules");
const { shopFilter } = require("../utils/sellerQueries");
const { sharedProductIds } = require("../utils/productRules");
const { getOrderStats, getListingStats } = require("../utils/statsQueries");

// The whitelist for "these prices are still right". Exactly ONE of the two
// keys is allowed (checked in the controller):
//   { listingIds: [...] }  these items (e.g. the ones ticked on screen)
//   { shop: "<id>" }       every item in this one shop
// The list is capped at 200, so one request can't carry a huge array.
// `shop` must not be empty: "" would otherwise read as "no shop given" and
// quietly confirm every item in EVERY shop of the seller.
const confirmSchema = z.object({
  listingIds: z
    .array(z.string(), { error: "listingIds must be a list of listing ids" })
    .min(1, "listingIds must not be empty")
    .max(200, "Too many listings (max 200 at a time)")
    .optional(),
  shop: z.string({ error: "shop must be a shop id" }).min(1, "Invalid shop id").optional(),
});

// GET /api/seller/shops
// Every shop I own, OPEN AND CLOSED, oldest first (so the shop made at sign-up
// comes first).
//
// Why this is needed: login returns { token, user } and no shops. Before this
// endpoint, the dashboard could only find a seller's shop in the PUBLIC list,
// which hides closed shops, so a seller who closed their shop lost it.
//
// Not paginated: a seller owns a handful of shops, not thousands. The filter is
// the logged-in user's own id from the token, never something the client sends,
// so nobody can ask for another seller's shops.
async function listMyShops(req, res) {
  const shops = await Shop.find({ owner: req.user.id })
    // A shop an admin locked carries `lock` (reason, date), so the dashboard can
    // explain why it's closed and why "open" is greyed out. Which admin did it
    // is internal, so that one field is left out ("-" = everything except).
    .select("-lock.lockedBy")
    // _id breaks ties: two shops created in the same millisecond still come
    // back in one fixed order.
    .sort({ createdAt: 1, _id: 1 })
    .populate("category")
    .populate(ZONE_POPULATE);

  res.json({ shops });
}

// POST /api/seller/listings/confirm
// "These prices are still right." Marks items as confirmed NOW without changing
// their price, either a chosen set ({ listingIds }) or a whole shop ({ shop }).
// Replies { confirmed: <how many items were marked> }.
//
// NEW CONCEPT: updateMany.
// Until now, every change loaded ONE document, changed it, and saved it. That's
// fine for one item, but a seller confirming 80 prices would mean 80 loads and
// 80 saves. updateMany sends ONE command to the database: "for every listing that
// matches this filter, set priceConfirmedAt to now". The database does it all in
// one go and only reports back how many documents matched.
//
// SECURITY lives in the filter: it always includes `shop ∈ my shops`. A listing
// id belonging to someone else simply doesn't match, so it's never touched, and
// it isn't counted. We don't need to load and check each listing one by one.
async function confirmPrices(req, res, next) {
  const result = confirmSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const { listingIds, shop } = result.data;

  // Exactly one of the two: both, or neither, is a mistake.
  if ((listingIds === undefined) === (shop === undefined)) {
    return next({ status: 400, message: "Send either listingIds or shop" });
  }

  // { shop: { $in: myShopIds } } for a list of ids, or { shop: id } for one of
  // my shops (someone else's shop → 403, a malformed id → 400).
  const { problem, filter } = await shopFilter(req.user, shop);
  if (problem) {
    return next(problem);
  }

  if (listingIds) {
    // Guard each id, or MongoDB would throw on a malformed one (→ 500).
    if (!listingIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
      return next({ status: 400, message: "Invalid listing id" });
    }
    filter._id = { $in: listingIds };
  }

  // Mongoose also refreshes `updatedAt` on an updateMany, as on a save.
  const update = await Listing.updateMany(filter, {
    $set: { priceConfirmedAt: new Date() },
  });

  // matchedCount = how many listings fit the filter (so: mine, and asked for).
  res.json({ confirmed: update.matchedCount });
}

// GET /api/seller/stats
// The dashboard's number cards, for all my shops, or one with ?shop=<id>:
//   { orders, completedValue, topProducts, listings }
// Every number is worked out in utils/statsQueries.js. This function only
// decides WHICH shops count. The admin's numbers (later) will call the same
// helpers with an empty filter, so both dashboards count the same way.
async function getMyStats(req, res, next) {
  const { problem, filter } = await shopFilter(req.user, req.query.shop);
  if (problem) {
    return next(problem);
  }

  const [orderStats, listings] = await Promise.all([
    getOrderStats(filter),
    getListingStats(filter),
  ]);

  // Cards only for now. If a daily chart is agreed with the frontend later, it
  // becomes one NEW key here, and nothing that already exists changes.
  res.json({ ...orderStats, listings });
}

// GET /api/seller/products
// The catalog products I ADDED, newest first, paginated, each with `canEdit`:
//   true  → nobody else sells it yet, so I may still fix it
//           (PATCH /api/products/:id);
//   false → another seller's shop lists it now, so only an admin can change it.
// The dashboard uses canEdit to show or grey out the edit button, instead of
// letting the seller try and get a 403 product_shared.
//
// (Products I merely SELL, added by someone else, are my items:
// GET /api/seller/listings.)
async function listMyProducts(req, res) {
  const { page, limit, skip } = parsePagination(req.query);

  // createdBy is hidden from results (select: false), but a filter can still
  // use it.
  const filter = { createdBy: req.user.id };

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("category", "name nameAr"),
    Product.countDocuments(filter),
  ]);

  // One query for the whole page: which of these does another seller list?
  const shared = await sharedProductIds(
    products.map((p) => p._id),
    req.user.id
  );

  res.json({
    // toObject() turns each Mongoose document into a plain object, so we can
    // add a field that isn't part of the schema.
    products: products.map((p) => ({
      ...p.toObject(),
      canEdit: !shared.has(p._id.toString()),
    })),
    page,
    limit,
    total,
  });
}

module.exports = { listMyShops, confirmPrices, getMyStats, listMyProducts };
