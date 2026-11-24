const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { notify } = require("./notify");
const { priceDrop, backInStock, newReview } = require("./notificationMessages");

// WHO gets an ALERT, and when. Like utils/orderNotifications.js, the
// controllers call these AFTER saving their change, one line each, and neither
// function ever throws (the change is already saved; an alert problem must not
// turn that success into an error).

// After a seller (or admin) edits a listing's price or stock.
//
// `before` is { price, inStock } as they were BEFORE the edit; `listing` is the
// listing after it was saved; `shop` is its shop (already loaded by the
// controller for the ownership check).
//
//   out of stock → in stock          → "back in stock"
//   price went DOWN, and in stock    → "price drop"
//   anything else (price rose, same price, still out of stock) → nothing
//
// Who hears: every customer whose cart holds THIS listing (this shop's price
// for this product). A customer who has the same product from a different shop
// in their cart isn't told: that's a different price.
async function notifyListingChanged(listing, before, shop, actorId) {
  try {
    const cameBack = !before.inStock && listing.inStock;
    const gotCheaper = listing.inStock && listing.price < before.price;
    if (!cameBack && !gotCheaper) return;

    // Nothing to tell if the customer couldn't buy it anyway: the shop is closed
    // or locked (isActive false), or an admin has hidden the product.
    if (!shop || !shop.isActive) return;
    const product = await Product.findById(listing.product).select("name nameAr isActive");
    if (!product || product.isActive === false) return;

    // "Which carts hold this listing?" Each cart keeps its lines in an `items`
    // ARRAY, and "items.listing" asks MongoDB to look inside that array. The
    // index on items.listing (models/Cart.js) makes this fast.
    const carts = await Cart.find({ "items.listing": listing._id }).select("customer");
    if (carts.length === 0) return;

    await notify({
      recipients: carts.map((c) => c.customer),
      event: cameBack ? "back_in_stock" : "price_drop",
      message: cameBack
        ? backInStock(product, shop.name, listing.price)
        : priceDrop(product, shop.name, listing.price, before.price),
      link: { listing: listing._id, product: product._id, shop: shop._id },
      actorId,
      // One unread alert per listing: a newer alert replaces an unread older one.
      replaceUnread: true,
    });
  } catch (err) {
    console.error("Could not send listing alerts:", err.message);
  }
}

// After a customer writes a NEW review (editing one doesn't notify): tell the
// shop's owner. `shop` is already loaded by the review controller.
async function notifyNewReview(shop, review, actorId) {
  await notify({
    recipients: [shop.owner],
    event: "new_review",
    message: newReview(shop.name, review.rating),
    link: { shop: shop._id },
    actorId,
  });
}

module.exports = { notifyListingChanged, notifyNewReview };
