// Shared query + rule helpers for Orders (Step 12).
//
// Why this file exists: the same "one canonical version, so two callers can
// never drift apart" idea as utils/homeQueries.js and utils/searchQueries.js.
// Three different endpoints read an order, and if each wrote its own populate
// they would slowly disagree about which fields an order exposes. So the ONE
// description of a readable order lives here, and everything calls it.
//
// These functions know NOTHING about HTTP — no req, no res, no status codes.
// They return documents or plain values, and the controller decides what to do
// with them (exactly like utils/pagination.js returning numbers).

const Order = require("../models/Order");
const Shop = require("../models/Shop");

// The full set of statuses an order can be in. Exported so the controller can
// validate a `?status=` query param against it — the same "check it against a
// whitelist, 400 if it isn't in there" trick that /api/search uses for `?type=`.
const ORDER_STATUSES = [
  "pending",
  "accepted",
  "ready",
  "completed",
  "cancelled",
];

// --- The shared populate --------------------------------------------------
// ONE description of what a "readable order" looks like, used by the
// single-order read AND the list endpoints, so they can't drift.
//
// NOTICE WHAT WE DON'T POPULATE: `items.listing` and `items.product`.
//
// That is deliberate, and it's the exact OPPOSITE of getPopulatedCart in
// controllers/cart.controller.js — for the exact opposite reason. A cart must
// be LIVE, so it populates the listing to get today's price. An order is
// FROZEN: every line already carries its own productName / productNameAr /
// unit / priceAtOrder, so an order renders fully with ZERO joins — and,
// crucially, still renders correctly after the listing has been deleted.
//
// `customer` is populated to name + phone ONLY. The seller needs those to make
// the call that fulfils the order — that IS the product — but email and
// passwordHash are never even loaded, so they cannot leak. `shop` uses the same
// safe public trio the cart already exposes.
const ORDER_POPULATE = [
  { path: "customer", select: "name phone" },
  { path: "shop", select: "name area phone" },
];

// Load ONE order, fully populated. Returns null if the id matches nothing.
function getPopulatedOrder(orderId) {
  return Order.findById(orderId).populate(ORDER_POPULATE);
}

// Load a PAGE of orders matching any filter, newest first.
//
// The caller supplies the filter (`{ customer }` for "my orders", `{ shop: {
// $in: [...] } }` for a seller's inbox) and the skip/limit from
// parsePagination. Sorting by createdAt: -1 matches both indexes on the Order
// model, so MongoDB returns the rows already in order.
function findOrders(filter, { skip, limit }) {
  return Order.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate(ORDER_POPULATE);
}

// Is this user the seller who owns the order's shop?
//
// Note the second database read. `order.shop` may be populated with the safe
// public whitelist ("name area phone"), which deliberately does NOT include
// `owner` — so we cannot answer this question from the populated document.
//
// The fix is to load the shop again asking ONLY for `owner`, NOT to widen the
// public select. Widening it would leak the owner's id into every order
// response forever just to save one cheap, indexed lookup by _id. Same
// listing → shop → owner idiom as controllers/listing.controller.js.
//
// The `!shop` guard covers an orphaned order whose shop was somehow removed.
async function isOrderSeller(order, userId) {
  const shopId = order.shop && order.shop._id ? order.shop._id : order.shop;
  const shop = await Shop.findById(shopId).select("owner");
  return !!shop && shop.owner.toString() === userId;
}

// Which role does this user play IN THIS ORDER?
//
// This is NOT the same thing as req.user.role. A user with the role "seller" is
// a stranger to an order placed at somebody else's shop. What matters is their
// relationship to THIS document:
//
//   "admin"    → oversees the whole marketplace
//   "customer" → the person who placed this order
//   "seller"   → owns the shop that has to fulfil it
//   null       → a stranger; the controller turns this into a 403
//
// Checked in that priority order. Slice 12.2's transition table takes this
// value, never req.user.role directly.
async function resolveActorRole(order, user) {
  if (user.role === "admin") return "admin";

  // order.customer may be a raw ObjectId or a populated document, depending on
  // how the order was loaded — handle both.
  const customerId =
    order.customer && order.customer._id ? order.customer._id : order.customer;
  if (customerId.toString() === user.id) return "customer";

  if (await isOrderSeller(order, user.id)) return "seller";

  return null;
}

// Prices are plain Numbers, and computers store decimals in binary — so
// 0.1 + 0.2 famously comes out as 0.30000000000000004. Every money value we
// COMPUTE (never one we simply copy) goes through here: scale up by 100, round
// to a whole number of agorot, scale back down. Same trick recalcShopRating
// uses to keep ratingAvg at one decimal place.
function money(n) {
  return Math.round(n * 100) / 100;
}

module.exports = {
  ORDER_STATUSES,
  ORDER_POPULATE,
  getPopulatedOrder,
  findOrders,
  isOrderSeller,
  resolveActorRole,
  money,
};
