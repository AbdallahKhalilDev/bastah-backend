const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { createProduct } = require("../controllers/product.controller");

const router = express.Router();

// Thin route: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// Create a product. Middleware runs left-to-right BEFORE the controller:
//   auth                       → verifies the token, sets req.user (else 401)
//   requireRole("seller",...)  → allows only these roles through (else 403)
// Only then does createProduct run.
//
// (The public GET /api/products browse + GET /api/products/:id details come in
// Step 6, so there are no read routes here yet.)
router.post(
  "/",
  auth,
  requireRole("seller", "admin"),
  asyncHandler(createProduct)
);

module.exports = router;
