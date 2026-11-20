const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  listMyShops,
  listMyListings,
  confirmPrices,
} = require("../controllers/seller.controller");

const router = express.Router();

// The seller dashboard. Guarded ONCE for every route below, the same
// router-level guard as /api/admin:
//
//   no token / bad token     → 401 (auth)
//   logged in, not a seller  → 403 (requireRole), admins included: an admin
//                              looks at a seller through /api/admin instead.
router.use(auth, requireRole("seller"));

router.get("/shops", asyncHandler(listMyShops)); // all my shops, closed ones too
router.get("/listings", asyncHandler(listMyListings)); // my items, paginated; ?staleDays= for old prices
router.post("/listings/confirm", asyncHandler(confirmPrices)); // "these prices are still right"

module.exports = router;
