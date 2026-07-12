const mongoose = require("mongoose");
const Shop = require("../models/Shop");

// GET /api/shops
// Public. Returns every ACTIVE shop, sorted by name.
async function listShops(req, res, next) {
  // find({ isActive: true }) hides any shop we've deactivated. When there are no
  // shops yet this simply returns [] — an empty list is a correct, successful
  // answer (status 200), not an error.
  //
  // .populate() swaps a stored reference id for the real document it points at:
  //   - "category" → the full Category (so the client sees its name, not an id)
  //   - "owner", "name" → the owner User, but ONLY their `name` field. This is a
  //     PUBLIC endpoint, so we must never leak the owner's email or passwordHash.
  //     The second argument is a "projection" — the whitelist of fields to send.
  const shops = await Shop.find({ isActive: true })
    .sort({ name: 1 })
    .populate("category")
    .populate("owner", "name");

  res.json({ shops });
}

// GET /api/shops/:id
// Public. Returns a single ACTIVE shop by its MongoDB id.
async function getShop(req, res, next) {
  // 1. Guard the id FIRST. `:id` comes straight from the URL, so it could be
  //    anything ("abc", "123"...). If it isn't a valid ObjectId, Mongoose's
  //    findById would throw a CastError. We'd rather tell the caller clearly
  //    that the id is malformed (400).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Look it up, populating the same public fields as the list above.
  const shop = await Shop.findById(req.params.id)
    .populate("category")
    .populate("owner", "name");

  // 3. Treat "not found" and "hidden" the same way: a 404. A deactivated shop
  //    (isActive === false) must not be reachable by direct link either, so we
  //    don't reveal it exists. (Sellers/admins still edit it by id via PATCH.)
  if (!shop || !shop.isActive) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 4. Success: send the single shop back, wrapped in a named key.
  res.json({ shop });
}

module.exports = { listShops, getShop };
