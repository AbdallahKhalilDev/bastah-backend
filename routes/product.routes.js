const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  createProduct,
  listProducts,
  getProduct,
  searchProducts,
  getFeaturedProducts,
  getNewArrivals,
  setFeatured,
} = require("../controllers/product.controller");
const { listProductListings } = require("../controllers/listing.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// ROUTE ORDER MATTERS. Express tries routes top-to-bottom, and `GET /:id`
// matches ANY single segment — including a literal word like "search". So more
// specific paths must come BEFORE `/:id`. The search route (Slice 3) will slot
// in above `/:id` for exactly this reason.

// Public reads (no auth).
router.get("/", asyncHandler(listProducts)); // browse, paginated
// Search MUST be registered before "/:id" — otherwise "/api/products/search"
// would be matched by "/:id" (treating the word "search" as a product id).
router.get("/search", asyncHandler(searchProducts));
// Home-page reads. Same route-order rule as /search: these literal words MUST be
// registered before "/:id", or Express would treat "featured"/"new" as an id.
router.get("/featured", asyncHandler(getFeaturedProducts)); // Home: featured strip
router.get("/new", asyncHandler(getNewArrivals)); // Home: new arrivals
router.get("/:id", asyncHandler(getProduct)); // one product's details
// Price comparison: every shop's price for one product, cheapest first. Two
// segments (/:id/listings), so it never clashes with the one-segment /:id above.
router.get("/:id/listings", asyncHandler(listProductListings));

// Create a product. Middleware runs left-to-right BEFORE the controller:
//   auth                       → verifies the token, sets req.user (else 401)
//   requireRole("seller",...)  → allows only these roles through (else 403)
// Only then does createProduct run.
router.post(
  "/",
  auth,
  requireRole("seller", "admin"),
  asyncHandler(createProduct)
);

// Feature / un-feature a product. ADMIN ONLY — featuring is an editorial decision
// (like verifying a shop), so requireRole is "admin" alone, NOT "seller". A seller
// can never promote their own product to the Home page. This is a two-segment
// path AND a different method (PATCH), so it never collides with GET /:id above.
router.patch(
  "/:id/feature",
  auth,
  requireRole("admin"),
  asyncHandler(setFeatured)
);

module.exports = router;
