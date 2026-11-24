const Shop = require("../models/Shop");
const notify = require("./notify");
const {
  orderPlaced,
  orderStatusForCustomer,
  orderStatusForSeller,
} = require("./notificationMessages");

// WHO hears about an order, and when. The order controller calls these two
// functions AFTER it has saved its change, one line each, so the "who gets
// told" rules live here and the controller stays about orders.
//
// Like notify() itself, neither function ever throws: the order is already
// saved, and a notification problem must never turn that success into an error.
// (notify() catches its own errors; the try/catch here covers the shop lookup.)

// After checkout: one "new order" notification per created order, to the owner
// of that order's shop. Checkout already loaded the shops (with their owners),
// so it passes them in and we don't look them up again.
async function notifyOrdersPlaced(orders, shopById, customerId) {
  try {
    for (const order of orders) {
      const shop = shopById.get(order.shop.toString());
      if (!shop) continue;
      await notify({
        recipients: [shop.owner],
        event: "order_placed",
        message: orderPlaced(order, shop.name),
        link: { order: order._id, shop: shop._id },
        actorId: customerId,
      });
    }
  } catch (err) {
    console.error("Could not send new-order notifications:", err.message);
  }
}

// After a status change. An order has two sides, the CUSTOMER who placed it and
// the SELLER who owns the shop. The rule is simply: tell every side except the
// one who made the change.
//
//   the seller moved it    → tell the customer
//   the customer cancelled → tell the seller
//   an admin moved it      → tell both (and never the admin)
//
// `actorRole` is the caller's role IN THIS ORDER (from resolveActorRole), not
// their account role.
async function notifyOrderStatusChanged(order, actorRole, actorId) {
  try {
    const shop = await Shop.findById(order.shop).select("name owner");
    if (!shop) return;

    const event = `order_${order.status}`;
    const link = { order: order._id, shop: shop._id };

    if (actorRole !== "customer") {
      await notify({
        recipients: [order.customer],
        event,
        message: orderStatusForCustomer(order, shop.name),
        link,
        actorId,
      });
    }
    if (actorRole !== "seller") {
      await notify({
        recipients: [shop.owner],
        event,
        message: orderStatusForSeller(order, shop.name, actorRole),
        link,
        actorId,
      });
    }
  } catch (err) {
    console.error("Could not send order-status notifications:", err.message);
  }
}

module.exports = { notifyOrdersPlaced, notifyOrderStatusChanged };
