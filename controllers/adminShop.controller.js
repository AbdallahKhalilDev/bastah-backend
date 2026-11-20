// The admin dashboard's SHOP screens: every shop in the marketplace, and the
// "verified" badge.
//
// Every route here is admin-only. That's enforced ONCE, in
// routes/admin.routes.js (router.use), so these functions don't repeat it.
//
// Editing a shop's details is NOT here: an admin already edits any shop with
// PATCH /api/shops/:id (and its delivery zones with PATCH .../delivery-zones).
// Adding a shop FOR a seller lives with the users, in admin.controller.js
// (POST /api/admin/users/:id/shops).
const mongoose = require("mongoose");
const { z } = require("zod");
const Shop = require("../models/Shop");
const parsePagination = require("../utils/pagination");
const parseBooleanQuery = require("../utils/booleanQuery");
const escapeRegex = require("../utils/escapeRegex");
const { ZONE_POPULATE } = require("../utils/shopRules");
const { lockShop, unlockShop } = require("../utils/shopLocks");

// What an admin sees about a shop's OWNER. Much more than the public's
// "name only": an admin may need to phone the seller, or see that they're
// suspended. Never the password hash.
const ADMIN_OWNER_FIELDS = "name email phone status";

// The ONE way an admin reply fills in a shop's links, so the list and the
// verify reply have the same shape.
function populateForAdmin(query) {
  return query
    .populate("owner", ADMIN_OWNER_FIELDS)
    .populate("category", "name nameAr")
    .populate(ZONE_POPULATE)
    // Which admin locked it, by name (a locked shop only).
    .populate("lock.lockedBy", "name");
}

// An explicit set, like featuring a product: { "isVerified": true } or false.
// Calling it twice with the same value is fine.
const setVerifiedSchema = z.object({
  isVerified: z.boolean({ error: "isVerified must be true or false" }),
});

// Lock: { "locked": true, "reason": "..." }   Unlock: { "locked": false }
// The seller reads the reason on their dashboard, so it has a length limit like
// every text field (and the same 500 as a suspension reason).
const setLockSchema = z.object({
  locked: z.boolean({ error: "locked must be true or false" }),
  reason: z.string().trim().max(500, "Reason is too long (max 500 characters)").optional(),
});

// GET /api/admin/shops
// EVERY shop, open AND closed, newest first, paginated. The public list only
// shows open shops, and the seller list only shows the seller's own.
// Optional filters (they combine):
//   ?q=text                 name or area contains this text
//   ?isActive=true|false    open / closed shops
//   ?isVerified=true|false  verified / not verified
//   ?locked=true|false      locked by an admin / not locked
//   ?owner=<userId>         one seller's shops
async function listAllShops(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  const isActive = parseBooleanQuery(req.query.isActive, "isActive");
  if (isActive.problem) return next(isActive.problem);
  if (isActive.value !== undefined) filter.isActive = isActive.value;

  const isVerified = parseBooleanQuery(req.query.isVerified, "isVerified");
  if (isVerified.problem) return next(isVerified.problem);
  if (isVerified.value !== undefined) filter.isVerified = isVerified.value;

  // "Locked" = has a lock record. `null` also matches shops with no `lock`
  // stored at all (every shop made before locks existed), so "not locked" is
  // `lock: null` and "locked" is "anything but null".
  const locked = parseBooleanQuery(req.query.locked, "locked");
  if (locked.problem) return next(locked.problem);
  if (locked.value !== undefined) filter.lock = locked.value ? { $ne: null } : null;

  if (req.query.owner) {
    if (!mongoose.Types.ObjectId.isValid(req.query.owner)) {
      return next({ status: 400, message: "Invalid owner id" });
    }
    filter.owner = req.query.owner;
  }

  // "Contains", ignoring capitals, with "(" or "+" matched literally (the same
  // escapeRegex as every other search).
  const q = String(req.query.q || "").trim();
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: pattern }, { area: pattern }];
  }

  const [shops, total] = await Promise.all([
    populateForAdmin(
      Shop.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)
    ),
    Shop.countDocuments(filter),
  ]);

  res.json({ shops, page, limit, total });
}

// PATCH /api/admin/shops/:id/verify   body: { "isVerified": true | false }
// Gives a shop the "verified" badge, or takes it away. ONLY admins can: the
// shop whitelist drops `isVerified`, so a seller can't verify their own shop
// through PATCH /api/shops/:id. Closed shops can be verified too.
async function setShopVerified(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  const result = setVerifiedSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }

  const shop = await Shop.findById(req.params.id);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  shop.isVerified = result.data.isVerified;
  await shop.save();

  // Reload with the same links as the list, so the dashboard can swap the row.
  const populated = await populateForAdmin(Shop.findById(shop._id));
  res.json({ shop: populated });
}

// PATCH /api/admin/shops/:id/lock
//   { "locked": true, "reason": "Selling fake products" }   close it + lock it
//   { "locked": false }                                     unlock it
//
// Locking closes the shop (customers stop seeing it at once) and the seller
// can't re-open it. Unlocking puts it back as it was before the lock: open if it
// was open, closed if the seller had closed it.
// Asking for the state it's already in → 409 (like suspending a suspended
// account): most likely two admins acted at once, and the screen needs a refresh.
//
// An admin may also unlock a shop that was locked because its owner was
// suspended. That's the admin's decision; switching the owner back on later
// simply leaves that shop alone.
async function setShopLock(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  const result = setLockSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }
  const { locked, reason } = result.data;

  // The seller is told why, so locking needs a reason (like a suspension).
  if (locked && !reason) {
    return next({ status: 400, message: "A reason is required to lock a shop" });
  }

  const shop = await Shop.findById(req.params.id);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  if (locked) {
    if (shop.lock) {
      return next({ status: 409, message: "Shop is already locked" });
    }
    lockShop(shop, { reason, adminId: req.user.id });
  } else {
    if (!shop.lock) {
      return next({ status: 409, message: "Shop is not locked" });
    }
    unlockShop(shop);
  }
  await shop.save();

  const populated = await populateForAdmin(Shop.findById(shop._id));
  res.json({ shop: populated });
}

module.exports = { listAllShops, setShopVerified, setShopLock };
