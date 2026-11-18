// The seller dashboard's READS: "my shops" and "my items".
//
// Every route here is seller-only. The check happens ONCE, at the top of
// routes/seller.routes.js (router.use), exactly like /api/admin.
//
// Actions that already have a home stay there: a seller still edits a shop with
// PATCH /api/shops/:id and a price with PATCH /api/listings/:id. This file only
// answers "show me what's mine", including the things customers can't see
// (closed shops and their items).
const Shop = require("../models/Shop");
const Listing = require("../models/Listing");
const parsePagination = require("../utils/pagination");
const { ZONE_POPULATE } = require("../utils/shopRules");
const { shopFilter } = require("../utils/sellerQueries");

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
// Optional filters:
//   ?shop=<id>             one of my shops only (someone else's → 403)
//   ?inStock=true|false    only items in stock / out of stock
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

  const [listings, total] = await Promise.all([
    Listing.find(filter)
      .sort({ createdAt: -1, _id: -1 })
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

module.exports = { listMyShops, listMyListings };
