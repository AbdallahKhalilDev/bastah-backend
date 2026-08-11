const mongoose = require("mongoose");
const { z } = require("zod");
const Order = require("../models/Order");
const Shop = require("../models/Shop");
const Cart = require("../models/Cart");
const parsePagination = require("../utils/pagination");
// We IMPORT the cart's read helper rather than writing our own. The cart
// already knows how to load itself with every listing's live price, product and
// shop attached — that is exactly what checkout needs, so there is no reason to
// describe it a second time.
const { getPopulatedCart } = require("./cart.controller");
const {
  ORDER_STATUSES,
  getPopulatedOrder,
  findOrders,
  resolveActorRole,
  money,
} = require("../utils/orderQueries");

// --- Input validation -----------------------------------------------------
// A WHITELIST for placing an order. Only these two keys are accepted.
//
// LOOK AT WHAT IS ABSENT, because that absence IS the security of this whole
// feature: `customer`, `shop`, `items`, `priceAtOrder`, `subtotal`, `total` and
// `status` are all missing, so zod strips them if a caller sends them. A client
// therefore CANNOT choose its own prices, put someone else's name on an order,
// or start an order at "completed". Every one of those values is computed by
// the server from the cart. Same mechanism that already protects `owner` and
// `isVerified` on a shop.
const createOrderSchema = z.object({
  contactPhone: z.string().min(1, "Contact phone is required"),
  note: z.string().optional(),
});

// POST /api/orders
// Protected: a logged-in CUSTOMER only (auth + requireRole run first, in the
// route). Turns the caller's cart into real orders.
//
// THE GUIDING RULE OF THIS FUNCTION: validate absolutely everything BEFORE
// writing anything. Steps 1–6 are pure reads; the only writes are at the very
// end. That ordering is what replaces a database transaction here (MongoDB
// multi-document transactions need a replica set, and we run a standalone
// mongod, so starting one would simply throw).
//
// TODO(transactions): with a replica set, steps 7–8 below should be wrapped in
// one transaction. Without it, two SIMULTANEOUS requests (e.g. two browser
// tabs) can both read a non-empty cart before either clears it, and both will
// create orders. We accept that: for a low-traffic app with human sellers who
// can cancel a duplicate in one tap, a rare duplicate is better than the
// alternative (clearing the cart FIRST, which loses it outright if the create
// then fails).
async function createOrder(req, res, next) {
  // 1. Validate the body against the whitelist FIRST. Bad shape → 400.
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. Load the caller's own cart, fully populated, via the CART's own helper.
  //    Resolved from the verified token — never from anything the client sends.
  const cart = await getPopulatedCart(req.user.id);
  if (!cart || cart.items.length === 0) {
    return next({ status: 400, message: "Cart is empty" });
  }

  // 3. PRE-PASS over every cart line. Pure reads, zero writes — we are only
  //    looking for reasons this checkout must not happen.
  for (const item of cart.items) {
    // The listing (or its shop) was deleted after it was added to the cart, so
    // populate left us a null. We do NOT silently drop the line: quietly
    // changing what somebody ordered is worse than making them look at it.
    if (!item.listing || !item.listing.shop) {
      return next({
        status: 409,
        message:
          "An item in your cart is no longer available. Remove it and try again.",
      });
    }
    if (!item.listing.inStock) {
      const name = item.listing.product
        ? item.listing.product.name
        : "An item in your cart";
      return next({ status: 409, message: `${name} is out of stock` });
    }
  }

  // 4. GROUP THE LINES BY SHOP. This is the heart of checkout: one cart can
  //    hold items from several shops, but an order belongs to exactly ONE shop,
  //    so we split the cart into one group per shop.
  //
  //    getPopulatedCart already attached each listing's shop, so this is a
  //    single pass over an array in memory — NO extra database queries.
  const groups = new Map();
  for (const item of cart.items) {
    const key = item.listing.shop._id.toString();
    if (!groups.has(key)) {
      groups.set(key, { shopId: item.listing.shop._id, lines: [] });
    }
    groups.get(key).lines.push(item);
  }

  // 5. ONE query for the real shop documents. We need these for something the
  //    cart's populate deliberately withholds: `isActive`. (The cart selects
  //    only "name area phone", and widening that select just for checkout would
  //    change what every cart response exposes.)
  const shopIds = [...groups.values()].map((g) => g.shopId);
  const shops = await Shop.find({ _id: { $in: shopIds } });
  const shopById = new Map(shops.map((s) => [s._id.toString(), s]));

  // 6. BUILD every order document in memory — still no writes. If anything is
  //    wrong we bail out here, having changed nothing at all.
  const docs = [];
  for (const [shopKey, group] of groups) {
    const shop = shopById.get(shopKey);

    // A shop that was hidden (or removed) since the item went in the cart can't
    // take orders. Rejecting the WHOLE checkout rather than skipping that shop
    // is deliberate — see the note at the end of this loop.
    if (!shop || !shop.isActive) {
      const name = shop ? shop.name : "One of the shops in your cart";
      return next({
        status: 409,
        message: `${name} is not accepting orders right now`,
      });
    }

    // FREEZE each line: copy the price and the display fields onto the order so
    // it never has to look at the listing again.
    const items = group.lines.map((item) => ({
      listing: item.listing._id,
      product: item.listing.product._id,
      productName: item.listing.product.name,
      productNameAr: item.listing.product.nameAr,
      unit: item.listing.product.unit,
      priceAtOrder: item.listing.price,
      quantity: item.quantity,
    }));

    const subtotal = money(
      items.reduce((sum, line) => sum + line.priceAtOrder * line.quantity, 0)
    );

    docs.push({
      customer: req.user.id,
      shop: shop._id,
      items,
      subtotal,
      // Today total === subtotal. Step 13 adds a delivery fee and this becomes
      // subtotal + deliveryFee — the frontend keeps reading the same field.
      total: subtotal,
      contactPhone: data.contactPhone,
      note: data.note,
    });
  }
  // A note on the two 409s above: either one rejects the ENTIRE checkout, not
  // just the offending shop's order. A partial checkout ("we ordered from 2 of
  // your 3 shops") is a surprise, and surprises are exactly what destroy trust
  // in a marketplace where no money is held and everything rests on the seller
  // turning up. The customer removes that shop's items and tries again.

  // 7. WRITE. insertMany sends all N documents in a SINGLE round trip (Mongoose
  //    still runs each document's schema validators). Because steps 3–6 already
  //    ruled out every BUSINESS reason a document could be rejected, by the time
  //    we reach here the only thing that can realistically fail is the server.
  const created = await Order.insertMany(docs);

  // 8. EMPTY THE CART — LAST, only once the orders actually exist.
  //
  //    Why empty it at all? The cart is documented as a live SHORTLIST, not a
  //    commitment; once it has become orders it has done its job. Leaving it
  //    full means the next press of the button silently creates a SECOND
  //    identical set of orders — and a human seller reading these as real
  //    requests cannot tell which one is real. Nothing is lost either: the
  //    ORDER is the receipt, and GET /api/orders shows it permanently at the
  //    frozen price.
  //
  //    A happy side effect: the cart is now its own idempotency token. A
  //    double-submit finds an empty cart and gets "Cart is empty" — no
  //    duplicates, with no extra field, request id, or dedupe table.
  //
  //    Doing it LAST matters. If this clear somehow fails, the customer has
  //    their orders AND a stale cart — annoying, and fixable with
  //    DELETE /api/cart. The reverse order could destroy a cart with no orders
  //    to show for it.
  const fresh = await Cart.findOne({ customer: req.user.id });
  if (fresh) {
    fresh.items = [];
    await fresh.save();
  }

  // 9. Return every order we just created, in the shared populated shape.
  //
  //    NOTE THE ARRAY. This is the one create endpoint in Bastah that returns a
  //    LIST rather than a single object, because one cart can legitimately
  //    become several orders. Frontends must handle that.
  const orders = await Promise.all(
    created.map((order) => getPopulatedOrder(order._id))
  );
  res.status(201).json({ orders });
}

// GET /api/orders
// Protected: a logged-in CUSTOMER only. Lists THIS caller's own orders, newest
// first, paginated. Optional ?status= narrows to one status.
async function listMyOrders(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  // Always scoped to the caller's own id from the token — a customer can never
  // ask for somebody else's orders, because there is no way to say whose.
  const filter = { customer: req.user.id };

  // ?status= is checked against the whitelist rather than trusted. Unlike
  // page/limit (which parsePagination quietly FIXES), a misspelt status is a
  // real mistake worth reporting — the same reasoning as ?type= on /api/search.
  if (req.query.status) {
    if (!ORDER_STATUSES.includes(req.query.status)) {
      return next({ status: 400, message: "Invalid status" });
    }
    filter.status = req.query.status;
  }

  // Run the page query and the count side by side — neither needs the other.
  const [orders, total] = await Promise.all([
    findOrders(filter, { skip, limit }),
    Order.countDocuments(filter),
  ]);

  res.json({ orders, page, limit, total });
}

// GET /api/orders/:id
// Protected: `auth` only, with NO requireRole — because three different kinds
// of user may legitimately read one order, and the rule depends on the ORDER,
// not on the role alone. (Same shape as PATCH /api/reviews/:id, which is
// author-only and therefore also decides inside the controller.)
//
// Visible to: the customer who placed it, the seller who owns its shop, or an
// admin. Everyone else gets a 403.
async function getOrder(req, res, next) {
  // 1. Guard the id from the URL before touching the database, or a malformed
  //    id makes findById throw a CastError and we'd answer 500 instead of 400.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid order id" });
  }

  // 2. An id in the URL PATH that matches nothing is a 404 — the route points
  //    at something that isn't there.
  const order = await getPopulatedOrder(req.params.id);
  if (!order) {
    return next({ status: 404, message: "Order not found" });
  }

  // 3. Who is the caller, RELATIVE TO THIS ORDER? null means "a stranger".
  const actorRole = await resolveActorRole(order, req.user);
  if (!actorRole) {
    return next({ status: 403, message: "Forbidden" });
  }

  res.json({ order });
}

module.exports = {
  createOrder,
  listMyOrders,
  getOrder,
};
