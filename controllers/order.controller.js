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
const Area = require("../models/Area");
const {
  ORDER_STATUSES,
  canTransition,
  getPopulatedOrder,
  findOrders,
  resolveActorRole,
  money,
  resolveDeliveryFee,
} = require("../utils/orderQueries");
const { shopFilter } = require("../utils/sellerQueries");
const {
  notifyOrdersPlaced,
  notifyOrderStatusChanged,
} = require("../utils/orderNotifications");

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
  // Omitted means "pickup" — which keeps every client written before delivery
  // existed working exactly as it did.
  deliveryMethod: z.enum(["pickup", "delivery"], {
    error: "Delivery method must be pickup or delivery",
  }).optional(),
  // Required only when deliveryMethod is "delivery". zod can express that with
  // .refine(), but a plain `if` after safeParse reads more clearly and is one
  // less new concept — see createOrder below.
  address: z
    .object({
      area: z.string().min(1, "Area is required"),
      details: z.string().optional(),
    })
    .optional(),
});

// A WHITELIST for moving an order along. `status` is the status you want to move
// it TO — z.enum rejects anything that isn't a real status before we ever look
// at the order, so the transition table only ever sees sensible values.
//
// `cancelReason` is only meaningful alongside a cancellation, and the controller
// ignores it otherwise. Note what's absent again: you cannot edit an order's
// items, prices or totals through here (or anywhere else) — an order is history.
const updateStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { error: "Invalid status" }),
  cancelReason: z.string().optional(),
});

// POST /api/orders
// Protected: a logged-in CUSTOMER only (auth + requireRole run first, in the
// route). Turns the caller's cart into real orders.
//
// THE GUIDING RULE OF THIS FUNCTION: validate absolutely everything BEFORE
// writing anything. Steps 1–6 are pure reads; the only writes are at the very
// end. That ordering is what replaces a database transaction here (MongoDB
// multi-document transactions need a replica set, and we run a standalone
// mongod locally, so starting one would simply throw).
//
// Step 7 "claims" the cart before any order is written, so that several
// checkouts arriving at the SAME moment (a double-tap on a phone) can't each
// create a set of orders. See step 7 for how.
//
// Every refusal carries a `code` (cart_empty, out_of_stock, ...) besides its
// English message, so the app can show its own Arabic text and offer the right
// fix: remove a line, switch to pickup, or open "My orders".
async function createOrder(req, res, next) {
  // 1. Validate the body against the whitelist FIRST. Bad shape → 400.
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 1b. Pickup or delivery? Default to pickup when unsaid.
  //
  //     A delivery order NEEDS somewhere to go, so the address becomes required
  //     here. Both of these are the caller's mistake, so both are 400 — and we
  //     check them BEFORE touching the cart, since neither depends on it.
  const isDelivery = data.deliveryMethod === "delivery";
  let area = null;
  if (isDelivery) {
    if (!data.address) {
      return next({ status: 400, message: "Delivery address is required" });
    }
    // The area id came in the BODY, so a bad one is a 400 (not a 404) — the
    // same rule createShop follows for a body-supplied category id.
    if (!mongoose.Types.ObjectId.isValid(data.address.area)) {
      return next({ status: 400, message: "Invalid area id" });
    }
    area = await Area.findById(data.address.area);
    // An area an admin has hidden is no longer offered (GET /api/areas leaves it
    // out), so nobody can order delivery to it, even where a shop still lists it.
    if (!area || area.isActive === false) {
      return next({ status: 400, message: "Area not found" });
    }
  }

  // 2. Load the caller's own cart, fully populated, via the CART's own helper.
  //    Resolved from the verified token — never from anything the client sends.
  const cart = await getPopulatedCart(req.user.id);
  // This is also what a RETRY gets after a checkout that worked but whose reply
  // never arrived: the orders exist and the cart is empty. The code lets the app
  // send the customer to "My orders" instead of showing an error.
  if (!cart || cart.items.length === 0) {
    return next({ status: 400, code: "cart_empty", message: "Cart is empty" });
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
        code: "item_unavailable",
        message:
          "An item in your cart is no longer available. Remove it and try again.",
      });
    }
    // An admin hid the product since it went in the cart. Same treatment as a
    // deleted listing: refuse the whole checkout, never drop the line quietly.
    // Same code too, because the fix is the same: remove that line.
    if (item.listing.product && item.listing.product.isActive === false) {
      return next({
        status: 409,
        code: "item_unavailable",
        message: `${item.listing.product.name} is no longer available. Remove it and try again.`,
      });
    }
    if (!item.listing.inStock) {
      const name = item.listing.product
        ? item.listing.product.name
        : "An item in your cart";
      return next({ status: 409, code: "out_of_stock", message: `${name} is out of stock` });
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
        code: "shop_closed",
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

    // THE DELIVERY FEE, resolved PER SHOP — each shop sets its own price for
    // each area it covers, so two orders from one checkout can carry different
    // fees. Like priceAtOrder, it's frozen here and never recomputed.
    let deliveryFee = 0;
    if (isDelivery) {
      const fee = resolveDeliveryFee(shop, area._id);
      // NOTE: `fee === null` means "this shop doesn't go there at all", which is
      // a completely different thing from a fee of 0 ("free delivery"). Testing
      // for null explicitly — never `fee || 0` — is what keeps those apart.
      if (fee === null) {
        return next({
          status: 409,
          code: "no_delivery_to_area",
          message: `${shop.name} does not deliver to ${area.name}`,
        });
      }
      deliveryFee = fee;
    }

    docs.push({
      customer: req.user.id,
      shop: shop._id,
      items,
      subtotal,
      deliveryFee,
      // ONE number for the frontend to display. It never has to know the
      // formula — which is exactly why we stored `total` from the first slice,
      // back when it merely equalled subtotal.
      total: money(subtotal + deliveryFee),
      deliveryMethod: isDelivery ? "delivery" : "pickup",
      deliveryAddress: isDelivery
        ? { area: area._id, details: data.address.details }
        : null,
      contactPhone: data.contactPhone,
      note: data.note,
    });
  }
  // A note on the three 409s above: any one of them rejects the ENTIRE
  // checkout, not just the offending shop's order. A partial checkout ("we
  // ordered from 2 of your 3 shops") is a surprise, and surprises are exactly
  // what destroy trust in a marketplace where no money is held and everything
  // rests on the seller turning up. The customer removes that shop's items (or
  // switches to pickup) and tries again.

  // 7. CLAIM THE CART: empty it in ONE database operation, but only if it is
  //    still exactly the cart we just checked.
  //
  //    Why empty it at all? The cart is a live SHORTLIST, not a commitment; once
  //    it has become orders it has done its job. Leaving it full means the next
  //    press of the button creates a SECOND identical set of orders, and a human
  //    seller can't tell which one is real. Nothing is lost: the ORDER is the
  //    receipt, and GET /api/orders shows it for good at the frozen price.
  //
  //    Why BEFORE writing the orders? Because of a double-tap. Two checkouts
  //    arrive together, and both read the full cart in step 2 before either has
  //    emptied it. If each one then simply wrote its orders, the customer would
  //    get two sets. So each request must first win the cart.
  //
  //    How one request "wins": updateOne with a filter finds the cart AND
  //    changes it in a single step, so no other request can slip in between.
  //    The filter only matches while:
  //      - updatedAt is still the value we read in step 2 (nobody changed the
  //        cart since, not another checkout and not the customer adding an item;
  //        every change to a cart moves its updatedAt), and
  //      - "items.0" exists, i.e. the cart still has a first item.
  //    The winner empties the cart (which also moves updatedAt). Every other
  //    request then matches nothing: modifiedCount is 0, and it stops here
  //    without writing anything.
  //
  //    A request that arrives a moment LATER, after the winner has finished,
  //    reads an empty cart in step 2 and gets "Cart is empty" instead. Both
  //    answers mean the same thing to the app: look in "My orders".
  const claimedItems = cart.items.map((item) => ({
    listing: item.listing._id,
    quantity: item.quantity,
  }));
  const claim = await Cart.updateOne(
    { _id: cart._id, updatedAt: cart.updatedAt, "items.0": { $exists: true } },
    { $set: { items: [] } }
  );
  if (claim.modifiedCount === 0) {
    return next({
      status: 409,
      code: "cart_changed",
      message: "Your cart changed during checkout. Check My orders, then try again.",
    });
  }

  // 8. WRITE. insertMany sends all N documents in a SINGLE round trip (Mongoose
  //    still runs each document's schema validators). Because steps 3–6 already
  //    ruled out every BUSINESS reason a document could be rejected, by the time
  //    we reach here the only thing that can realistically fail is the server.
  //
  //    If it does fail, the cart is already empty and no orders exist, so we PUT
  //    THE CART BACK before passing the error on (the same "undo it by hand"
  //    idea createAccount uses, since we have no transactions). We only restore
  //    it while it's still empty, so we never overwrite items the customer added
  //    in the meantime.
  let created;
  try {
    created = await Order.insertMany(docs);
  } catch (err) {
    await Cart.updateOne(
      { _id: cart._id, "items.0": { $exists: false } },
      { $set: { items: claimedItems } }
    );
    throw err;
  }

  // 8b. Tell each shop's owner they have a new order. This comes AFTER the
  //     orders and the cart are saved, and it never throws: a notification is a
  //     side effect, so a problem writing one can't spoil a successful checkout.
  //     `shopById` from step 5 already holds every shop with its owner.
  await notifyOrdersPlaced(created, shopById, req.user.id);

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

// GET /api/orders/incoming
// Protected: a logged-in SELLER or ADMIN. The seller's inbox — every order
// placed at any shop they own, newest first, paginated. An admin sees every
// order in the marketplace.
//
// Optional ?shop=<id> narrows it to ONE shop (a seller with several shops wants
// one inbox per shop). A seller may only name their own shops (else 403).
//
// "Which shops are mine?" is answered by shopFilter() in utils/sellerQueries.js,
// shared with the seller dashboard, so the inbox and the dashboard can never
// disagree about what a seller owns.
async function listIncomingOrders(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  const { problem, filter } = await shopFilter(req.user, req.query.shop);
  if (problem) {
    return next(problem);
  }

  // Same ?status= whitelist as listMyOrders: a misspelt status is a real
  // mistake worth reporting, not something to quietly ignore.
  if (req.query.status) {
    if (!ORDER_STATUSES.includes(req.query.status)) {
      return next({ status: 400, message: "Invalid status" });
    }
    filter.status = req.query.status;
  }

  const [orders, total] = await Promise.all([
    findOrders(filter, { skip, limit }),
    Order.countDocuments(filter),
  ]);

  res.json({ orders, page, limit, total });
}

// PATCH /api/orders/:id/status
// Protected: `auth` only, with NO requireRole — like GET /api/orders/:id, who
// may do what depends on the ORDER, not on the role alone. A customer may
// cancel their own pending order; the shop's owner may move it along; an admin
// may do anything a seller may. The rule book is the TRANSITIONS table in
// utils/orderQueries.js — this function just asks it and reports the answer.
async function updateOrderStatus(req, res, next) {
  // 1. Guard the id from the URL before any database call.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid order id" });
  }

  // 2. Load the order. An id in the URL path matching nothing is a 404.
  const order = await Order.findById(req.params.id);
  if (!order) {
    return next({ status: 404, message: "Order not found" });
  }

  // 3. Who is the caller RELATIVE TO THIS ORDER? A stranger gets 403 here, and
  //    never learns anything about the order's contents.
  const actorRole = await resolveActorRole(order, req.user);
  if (!actorRole) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body. z.enum has already ruled out anything that isn't a
  //    real status, so the table below only sees sensible values.
  const result = updateStatusSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. Ask the ONE rule book whether this move is allowed, and for this person.
  const verdict = canTransition({
    from: order.status,
    to: data.status,
    actorRole,
    // The table needs this to know whether "delivering" is a real move for THIS
    // order — it isn't, on a pickup order.
    deliveryMethod: order.deliveryMethod,
  });
  if (verdict === "illegal") {
    // The body was fine; it's the order's CURRENT STATE that conflicts.
    return next({
      status: 409,
      message: `Cannot change a ${order.status} order to ${data.status}`,
    });
  }
  if (verdict === "forbidden") {
    return next({ status: 403, message: "Forbidden" });
  }

  // 6. Make the move. cancelReason is only meaningful on a cancellation, so we
  //    ignore it otherwise rather than letting it linger on a completed order.
  order.status = data.status;
  if (data.status === "cancelled" && data.cancelReason !== undefined) {
    order.cancelReason = data.cancelReason;
  }
  await order.save();

  // 6b. Tell the other side of the order (never the person who just moved it).
  //     Only reached when the move really happened: every refusal above
  //     returned early, so a 400/403/409 never creates a notification.
  await notifyOrderStatusChanged(order, actorRole, req.user.id);

  // 7. Return the same populated shape every other order endpoint returns.
  res.json({ order: await getPopulatedOrder(order._id) });
}

module.exports = {
  createOrder,
  listMyOrders,
  listIncomingOrders,
  getOrder,
  updateOrderStatus,
};
