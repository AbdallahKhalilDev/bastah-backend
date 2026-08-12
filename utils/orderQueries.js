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
  "delivering",
  "completed",
  "cancelled",
];

// --- THE STATE MACHINE ----------------------------------------------------
// An order can't jump anywhere it likes. It walks a path:
//
//   pickup:    pending → accepted → ready ──────────────→ completed
//   delivery:  pending → accepted → ready → delivering → completed
//                 ↘         ↘         ↘          ↘
//                          cancelled
//
// ONE table covers both, and the trick that makes that work is what `ready`
// means: "the shop has the goods packed and set aside." For a pickup order
// that reads as "come and collect them"; for a delivery order it reads as
// "packed, about to leave." One state, one meaning, two readings.
//
// `delivering` is the only delivery-specific value, and it is legal ONLY when
// deliveryMethod === "delivery" — enforced in canTransition below, NOT by a
// second enum or a parallel table.
//
// `completed` means "THE CUSTOMER HAS THE GOODS". It does NOT mean "paid": no
// money moves through this app. `completed` and `cancelled` are TERMINAL —
// nothing leaves them, for anybody, including an admin.
//
// Read the table as: from THIS status you may move to THESE statuses, and each
// move is allowed only to THESE actors. A status missing from a row is not
// reachable from it; an empty row ({}) is a dead end.
//
// Keeping it as DATA rather than a pile of if-statements means the whole rule
// book is one thing you can read top to bottom — and adding a status later
// (Step 13 adds "delivering") is a new row, not new branching logic scattered
// across the controller.
//
// IMPORTANT: `actorRole` here is NOT req.user.role. It's the caller's role
// RELATIVE TO THIS ORDER — see resolveActorRole below. That distinction is what
// lets one small table express "the customer who placed it" vs "the seller who
// owns the shop" without the table knowing anything about users.
const TRANSITIONS = {
  pending: {
    accepted: ["seller", "admin"],
    // A customer may withdraw while it's still just a request — nothing has
    // been done yet, so nobody loses anything.
    cancelled: ["customer", "seller", "admin"],
  },
  accepted: {
    ready: ["seller", "admin"],
    // NOTE the customer is NOT here. Once the shop has accepted, they may have
    // set stock aside or started preparing. In a marketplace whose only
    // currency is trust, letting a customer silently vaporise real work is the
    // wrong default — after this point they phone the shop (which is the whole
    // premise of the app) and the SELLER cancels.
    cancelled: ["seller", "admin"],
  },
  ready: {
    // DELIVERY ORDERS ONLY — the extra check is in canTransition. On a pickup
    // order this move simply doesn't exist.
    delivering: ["seller", "admin"],
    completed: ["seller", "admin"],
    // The goods are packed with the customer's name on them. Only the shop can
    // call it off now (a no-show, say).
    cancelled: ["seller", "admin"],
  },
  delivering: {
    completed: ["seller", "admin"],
    // Nobody home, wrong address, and so on.
    cancelled: ["seller", "admin"],
  },
  // Terminal. Nobody un-completes or un-cancels an order.
  completed: {},
  cancelled: {},
};

// Can this move happen, and may THIS person make it?
//
// Returns one of three plain strings. It knows NOTHING about HTTP — the
// controller turns the answer into a status code, the same way
// utils/pagination.js returns numbers and lets the controller decide.
//
//   "ok"        → make the move
//   "illegal"   → this move doesn't exist FOR ANYONE  → controller sends 409
//   "forbidden" → the move exists, but not for YOU    → controller sends 403
//
// Why 409 and not 400 for an illegal move? The request body was perfectly
// valid — it's the CURRENT STATE of the order that conflicts with it. That's
// the same shape of problem as a duplicate key (which we already answer with
// 409). It also gives the frontend an actionable distinction: a 409 means
// "refresh, someone else moved this on", a 403 means "this button shouldn't be
// here for you".
function canTransition({ from, to, actorRole, deliveryMethod }) {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed[to]) return "illegal";

  // "delivering" only makes sense when the shop is actually bringing it. On a
  // pickup order this move doesn't exist FOR ANYONE — not even an admin — so
  // it's "illegal" (a 409), not "forbidden" (a 403).
  if (to === "delivering" && deliveryMethod !== "delivery") return "illegal";

  if (!allowed[to].includes(actorRole)) return "forbidden";
  return "ok";
}

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
  // The delivery address stores an Area id; swap it for the readable name so
  // the seller sees "Rimal", not an id. Harmless on pickup orders, where
  // deliveryAddress is null and there is nothing to populate.
  { path: "deliveryAddress.area", select: "name nameAr slug" },
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

// What does THIS shop charge to deliver to THIS area?
//
// Returns the fee, or **null** meaning "this shop does not deliver there at
// all". That distinction is the entire point of this function, and it's why the
// caller must NOT write `resolveDeliveryFee(...) || 0`: a fee of 0 is a real,
// meaningful answer ("free delivery"), and `|| 0` would silently turn "we don't
// go there" into "we go there for free". Check for null explicitly.
function resolveDeliveryFee(shop, areaId) {
  const zone = (shop.deliveryZones || []).find(
    (z) => z.area.toString() === String(areaId)
  );
  return zone ? zone.fee : null;
}

module.exports = {
  ORDER_STATUSES,
  TRANSITIONS,
  canTransition,
  ORDER_POPULATE,
  getPopulatedOrder,
  findOrders,
  isOrderSeller,
  resolveActorRole,
  money,
  resolveDeliveryFee,
};
