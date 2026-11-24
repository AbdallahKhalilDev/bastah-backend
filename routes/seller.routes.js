const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  listMyShops,
  confirmPrices,
  getMyStats,
  listMyProducts,
} = require("../controllers/seller.controller");
// The item list is shared with the admin dashboard (GET /api/admin/listings).
const { listDashboardListings } = require("../controllers/listing.controller");
const {
  createOffer,
  updateOffer,
  listDashboardOffers,
} = require("../controllers/offer.controller");

const router = express.Router();

// The seller dashboard. Guarded ONCE for every route below, the same
// router-level guard as /api/admin:
//
//   no token / bad token     → 401 (auth)
//   logged in, not a seller  → 403 (requireRole), admins included: an admin
//                              looks at a seller through /api/admin instead.
router.use(auth, requireRole("seller"));

router.get("/shops", asyncHandler(listMyShops)); // all my shops, closed ones too
router.get("/listings", asyncHandler(listDashboardListings)); // my items, paginated; ?staleDays= for old prices
router.post("/listings/confirm", asyncHandler(confirmPrices)); // "these prices are still right"
router.get("/stats", asyncHandler(getMyStats)); // the number cards; ?shop= for one shop
router.get("/products", asyncHandler(listMyProducts)); // products I added, each with canEdit

// Offers (slice 15.4). The same three functions as /api/admin/offers.
router.get("/offers", asyncHandler(listDashboardOffers)); // my shops' offers; ?shop=
router.post("/offers", asyncHandler(createOffer)); // one per shop per day; notifies its customers
router.patch("/offers/:id", asyncHandler(updateOffer)); // only offers I posted

module.exports = router;
