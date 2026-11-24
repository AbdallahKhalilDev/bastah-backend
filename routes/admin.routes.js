const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserPassword,
  setUserStatus,
  createUserShop,
} = require("../controllers/admin.controller");
const {
  listAllShops,
  setShopVerified,
  setShopLock,
} = require("../controllers/adminShop.controller");
const { listDashboardListings } = require("../controllers/listing.controller");
const {
  listAllProducts,
  setProductActive,
} = require("../controllers/adminProduct.controller");
const { categories, areas } = require("../controllers/adminLookup.controller");
const { getSiteStats, listAllReviews } = require("../controllers/adminOverview.controller");
const { sendAnnouncement } = require("../controllers/adminAnnouncement.controller");
const {
  createOffer,
  updateOffer,
  listDashboardOffers,
} = require("../controllers/offer.controller");

const router = express.Router();

// NEW CONCEPT: router-level middleware.
//
// Elsewhere we write `auth, requireRole(...)` on EACH route. Here, router.use()
// runs these two for EVERY request that reaches this router, before any route
// below. So every admin route is protected once, at the top, and a route added
// later can't forget the check.
//
//   no token / bad token → 401 (auth)
//   logged in, not admin → 403 (requireRole)
//
// It even covers paths that don't exist: a non-admin asking for
// /api/admin/anything gets 403, so outsiders can't map out the admin routes.
router.use(auth, requireRole("admin"));

router.get("/users", asyncHandler(listUsers));
router.post("/users", asyncHandler(createUser));
router.get("/users/:id", asyncHandler(getUser));
router.patch("/users/:id", asyncHandler(updateUser)); // name, email, phone
router.patch("/users/:id/password", asyncHandler(setUserPassword)); // never your own
router.patch("/users/:id/status", asyncHandler(setUserStatus)); // never your own
router.post("/users/:id/shops", asyncHandler(createUserShop)); // a shop FOR this seller

// Shops (slice 17.4). Editing a shop's details is the existing PATCH /api/shops/:id.
router.get("/shops", asyncHandler(listAllShops)); // every shop, closed ones too
router.patch("/shops/:id/verify", asyncHandler(setShopVerified)); // the "verified" badge
router.patch("/shops/:id/lock", asyncHandler(setShopLock)); // close a shop so its seller can't re-open it

// Items of any shop, open, closed or locked (?shop=, ?inStock=, ?staleDays=).
// The same function as the seller's GET /api/seller/listings.
router.get("/listings", asyncHandler(listDashboardListings));

// Products (slice 17.7). Editing one is the shared PATCH /api/products/:id.
router.get("/products", asyncHandler(listAllProducts)); // the whole catalog, hidden ones too
router.patch("/products/:id/active", asyncHandler(setProductActive)); // hide / show a product

// Categories and areas (slice 17.8): the same three endpoints for each, built
// by one factory. Hide with PATCH { isActive: false }; never deleted.
router.get("/categories", asyncHandler(categories.list)); // hidden ones too
router.post("/categories", asyncHandler(categories.create));
router.patch("/categories/:id", asyncHandler(categories.update)); // rename, icon, hide/show
router.get("/areas", asyncHandler(areas.list)); // hidden ones too
router.post("/areas", asyncHandler(areas.create));
router.patch("/areas/:id", asyncHandler(areas.update)); // rename, hide/show

// Overview (slice 17.9): the site-wide number cards, and every review.
// Removing a review is the existing DELETE /api/reviews/:id.
router.get("/stats", asyncHandler(getSiteStats));
router.get("/reviews", asyncHandler(listAllReviews));

// Notifications (slice 15.2): one message to the inbox of all customers, all
// sellers, or both (never admins; suspended accounts are skipped).
router.post("/announcements", asyncHandler(sendAnnouncement));

// Offers (slice 15.4): any open shop, no daily limit, edit or switch off any
// offer. The same three functions as /api/seller/offers.
router.get("/offers", asyncHandler(listDashboardOffers)); // every offer; ?shop=
router.post("/offers", asyncHandler(createOffer));
router.patch("/offers/:id", asyncHandler(updateOffer));

module.exports = router;
