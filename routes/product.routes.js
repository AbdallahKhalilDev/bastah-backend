const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  createProduct,
  listProducts,
  getProduct,
} = require("../controllers/product.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// ROUTE ORDER MATTERS. Express tries routes top-to-bottom, and `GET /:id`
// matches ANY single segment — including a literal word like "search". So more
// specific paths must come BEFORE `/:id`. The search route (Slice 3) will slot
// in above `/:id` for exactly this reason.

// Public reads (no auth).
router.get("/", asyncHandler(listProducts)); // browse, paginated
router.get("/:id", asyncHandler(getProduct)); // one product's details

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

module.exports = router;
