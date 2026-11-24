const Listing = require("../models/Listing");
const Shop = require("../models/Shop");
const User = require("../models/User");
const { notify } = require("./notify");
const {
  shopLocked,
  shopUnlocked,
  shopVerified,
  shopUnverified,
  productHidden,
  productShown,
} = require("./notificationMessages");

// ACCOUNT NOTICES: an admin changed something a seller owns, so the seller is
// told. Like the other *Notifications.js files, the admin controllers call these
// AFTER saving, one line each, and they never throw.
//
// The controllers call them ONLY when the value really changed. "Verify" and
// "hide/show product" answer 200 even when nothing changed (sending the same
// value twice is allowed), and the seller shouldn't get a second "your shop is
// verified" for that. (Lock/unlock already answers 409 when nothing would change.)
//
// A SUSPENSION also locks a seller's shops (utils/shopLocks.js), but that sends
// NO notices: a suspended seller can't log in to read them, and the login error
// already tells them why.

// The admin locked or unlocked one shop. `shop` is the saved shop.
async function notifyShopLockChanged(shop, actorId) {
  await notify({
    recipients: [shop.owner],
    event: shop.lock ? "shop_locked" : "shop_unlocked",
    message: shop.lock
      ? shopLocked(shop.name, shop.lock.reason)
      : shopUnlocked(shop.name, shop.isActive),
    link: { shop: shop._id },
    actorId,
  });
}

// The admin gave a shop the verified badge, or took it away.
async function notifyShopVerifiedChanged(shop, actorId) {
  await notify({
    recipients: [shop.owner],
    event: shop.isVerified ? "shop_verified" : "shop_unverified",
    message: shop.isVerified ? shopVerified(shop.name) : shopUnverified(shop.name),
    link: { shop: shop._id },
    actorId,
  });
}

// The admin hid a product, or showed it again. A product is shared by every
// shop that sells it, so several sellers care:
//   - the seller who CREATED it (createdBy), and
//   - the owner of every shop that LISTS it (sells it at their own price).
// One person can be both; notify() removes duplicates, so they get one notice.
//
// `product` must have been loaded with .select("+createdBy"): the schema hides
// that field from ordinary reads.
async function notifyProductVisibilityChanged(product, actorId) {
  try {
    // NEW CONCEPT: distinct(). It returns each DIFFERENT value of one field,
    // once. Listing.distinct("shop", ...) = "every shop that lists this
    // product", with no repeats. Then the same trick on Shop gives each owner
    // once, even if a seller lists it in three of their shops.
    const shopIds = await Listing.distinct("shop", { product: product._id });
    const ownerIds = await Shop.distinct("owner", { _id: { $in: shopIds } });

    // Account notices are for SELLERS. The creator could be an admin (admins
    // can add products too), so we keep only people whose role is seller.
    const candidates = [...ownerIds];
    if (product.createdBy) {
      candidates.push(product.createdBy);
    }
    const sellers = await User.find({ _id: { $in: candidates }, role: "seller" }).select("_id");

    const isVisible = product.isActive !== false;
    await notify({
      recipients: sellers.map((u) => u._id),
      event: isVisible ? "product_shown" : "product_hidden",
      message: isVisible ? productShown(product) : productHidden(product),
      link: { product: product._id },
      actorId,
    });
  } catch (err) {
    console.error("Could not send product notices:", err.message);
  }
}

module.exports = {
  notifyShopLockChanged,
  notifyShopVerifiedChanged,
  notifyProductVisibilityChanged,
};
