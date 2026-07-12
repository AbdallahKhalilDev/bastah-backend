const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  listShops,
  getShop,
  createShop,
  updateShop,
} = require("../controllers/shop.controller");
const {
  createListing,
  listShopProducts,
} = require("../controllers/listing.controller");
const { createReview } = require("../controllers/review.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// Public reads (no auth).
router.get("/", asyncHandler(listShops));
router.get("/:id", asyncHandler(getShop));
// A shop's product list (its listings, each with the product's details). Public,
// like the other reads. Two-segment path, so it never clashes with GET /:id.
router.get("/:shopId/products", asyncHandler(listShopProducts));

// Create a shop. Middleware runs left-to-right BEFORE the controller:
//   auth                       → verifies the token, sets req.user (else 401)
//   requireRole("seller",...)  → allows only these roles through (else 403)
// Only then does createShop run.
router.post("/", auth, requireRole("seller", "admin"), asyncHandler(createShop));

// Update a shop. Same auth + role gate as create. The per-shop ownership rule
// (a seller may edit only their OWN shop) is enforced inside the controller,
// because it needs to load the shop to compare its owner to the caller.
router.patch(
  "/:id",
  auth,
  requireRole("seller", "admin"),
  asyncHandler(updateShop)
);

// Add a listing (a price for a product) to THIS shop. The URL lives under a
// shop, so the route lives here, but the logic is listing logic and lives in
// listing.controller. Same auth + role gate as creating a shop; the per-shop
// ownership rule (a seller may add only to their OWN shop) is enforced inside
// the controller. This two-segment path (/:shopId/listings) never collides with
// the one-segment GET /:id above.
router.post(
  "/:shopId/listings",
  auth,
  requireRole("seller", "admin"),
  asyncHandler(createListing)
);

// Leave a review for THIS shop. Like listings, the URL lives under a shop, so the
// route lives here, but the logic is review logic in review.controller. Only a
// logged-in CUSTOMER may post (auth → requireRole("customer")); the author is
// taken from the token inside the controller. This two-segment path
// (/:shopId/reviews) never collides with the one-segment GET /:id above.
router.post(
  "/:shopId/reviews",
  auth,
  requireRole("customer"),
  asyncHandler(createReview)
);

module.exports = router;
