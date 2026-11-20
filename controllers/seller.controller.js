// The seller dashboard's READS: "my shops" and "my items".
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
const parsePagination = require("../utils/pagination");
const { ZONE_POPULATE } = require("../utils/shopRules");
const {
  shopFilter,
  staleFilter,
  MIN_STALE_DAYS,
  MAX_STALE_DAYS,
} = require("../utils/sellerQueries");
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
    // _id breaks ties: two shops created in the same millisecond still come
    // back in one fixed order.
    .sort({ createdAt: 1, _id: 1 })
    .populate("category")
    .populate(ZONE_POPULATE);

  res.json({ shops });
}

// GET /api/seller/listings
// My items (listings) across ALL my shops, newest first, paginated.
// Includes the items of CLOSED shops: the public item list
// (GET /api/shops/:shopId/products) answers 404 for those.
//
// Optional filters (they combine):
//   ?shop=<id>             one of my shops only (someone else's → 403)
//   ?inStock=true|false    only items in stock / out of stock
//   ?staleDays=<1..60>     only OLD prices: not confirmed in that many days, or
//                          never. Sorted OLDEST first (never-confirmed at the top),
//                          so the most out-of-date prices are seen first.
async function listMyListings(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  // { shop: { $in: myShopIds } }, or { shop: id } for ?shop=.
  const { problem, filter } = await shopFilter(req.user, req.query.shop);
  if (problem) {
    return next(problem);
  }

  // Query values always arrive as TEXT, so ?inStock=false is the string "false",
  // not the boolean false. We turn the two valid words into a real boolean and
  // reject anything else (a typo shouldn't silently show every item).
  if (req.query.inStock) {
    if (req.query.inStock !== "true" && req.query.inStock !== "false") {
      return next({ status: 400, message: "inStock must be true or false" });
    }
    filter.inStock = req.query.inStock === "true";
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
      // The shop's name so a multi-shop seller can tell items apart, and
      // isActive so the dashboard can mark items of a closed shop.
      .populate("shop", "name isActive"),
    Listing.countDocuments(filter),
  ]);

  res.json({ listings, page, limit, total });
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

module.exports = { listMyShops, listMyListings, confirmPrices, getMyStats };
