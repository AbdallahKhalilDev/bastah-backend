const Order = require("../models/Order");
const { notify } = require("./notify");
const { offerPosted } = require("./notificationMessages");

// WHO hears about a new offer: the shop's CUSTOMERS, meaning everyone with at
// least one order at that shop that wasn't cancelled. Customers who only ever
// cancelled, or never ordered, aren't told.
//
// notify() then removes suspended accounts (offers are a broadcast; see
// utils/notify.js) and the person who posted it.
//
// Returns how many customers were told, for the `notified` number in the reply.
// Never throws: the offer is already saved, and it stays posted even if the
// notifications fail.
async function notifyOfferPosted(offer, shop, actorId) {
  try {
    // distinct() again (as in utils/accountNotifications.js): each customer id
    // ONCE, so a customer with five orders here still gets one notification.
    const customerIds = await Order.distinct("customer", {
      shop: shop._id,
      status: { $ne: "cancelled" },
    });

    return await notify({
      recipients: customerIds,
      event: "offer",
      message: offerPosted(offer, shop.name),
      link: { offer: offer._id, shop: shop._id, product: offer.product || undefined },
      actorId,
    });
  } catch (err) {
    console.error("Could not send offer notifications:", err.message);
    return 0;
  }
}

module.exports = { notifyOfferPosted };
