// The rules for LOCKING a shop: an admin closes it, and the seller can't open
// it again until an admin unlocks it.
//
// Two things lock shops, and both come through here:
//   1. an admin, by hand          PATCH /api/admin/shops/:id/lock
//   2. suspending a seller        PATCH /api/admin/users/:id/status
//      (that locks every shop of theirs, and switching them back on undoes it)
//
// Locking works THROUGH the `isActive` field everyone already respects: a
// locked shop is simply closed. So the 8 places that already hide closed shops
// from customers (the shop list, shop page, its items, the price comparison,
// search, top stores, reviews and checkout) hide locked shops too, with no
// change to any of them. The `lock` record adds only what isActive can't say:
// WHO closed it, WHY, and what to go back to afterwards.
const Shop = require("../models/Shop");

// The reason shown on a shop that was locked because its owner was suspended.
// The admin's own suspension reason is NOT copied here: it's about the person,
// and it's already shown to them when they try to log in.
const SUSPENSION_LOCK_REASON = "The owner's account is suspended";

// Lock one (loaded) shop. The caller saves it.
function lockShop(shop, { reason, adminId, viaSuspension = false }) {
  shop.lock = {
    reason,
    lockedAt: new Date(),
    lockedBy: adminId,
    viaSuspension,
    // Remember whether it was open, so unlocking can put it back.
    wasActive: shop.isActive,
  };
  shop.isActive = false;
}

// Unlock one (loaded) shop, back to open or closed as it was. The caller saves it.
function unlockShop(shop) {
  shop.isActive = shop.lock.wasActive;
  shop.lock = null;
}

// A seller was suspended: lock every shop of theirs that isn't locked yet.
// A shop already locked by hand keeps its own lock (and its own reason), so
// switching the seller back on later won't open it by mistake.
// Returns how many shops were locked.
//
// One shop at a time, on purpose: each needs its OWN wasActive (some open, some
// closed), and a seller has a handful of shops, not thousands.
async function lockSellerShops(sellerId, adminId) {
  // `lock: null` matches shops with no lock stored at all, too.
  const shops = await Shop.find({ owner: sellerId, lock: null });
  for (const shop of shops) {
    lockShop(shop, { reason: SUSPENSION_LOCK_REASON, adminId, viaSuspension: true });
    await shop.save();
  }
  return shops.length;
}

// A seller was switched back on: unlock ONLY the shops their suspension locked.
// Returns how many shops were unlocked.
async function unlockSellerShops(sellerId) {
  const shops = await Shop.find({ owner: sellerId, "lock.viaSuspension": true });
  for (const shop of shops) {
    unlockShop(shop);
    await shop.save();
  }
  return shops.length;
}

module.exports = {
  SUSPENSION_LOCK_REASON,
  lockShop,
  unlockShop,
  lockSellerShops,
  unlockSellerShops,
};
