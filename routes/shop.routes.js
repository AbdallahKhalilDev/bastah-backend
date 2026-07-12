const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  listShops,
  getShop,
  createShop,
} = require("../controllers/shop.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// Public reads (no auth).
router.get("/", asyncHandler(listShops));
router.get("/:id", asyncHandler(getShop));

// Create a shop. Middleware runs left-to-right BEFORE the controller:
//   auth                       → verifies the token, sets req.user (else 401)
//   requireRole("seller",...)  → allows only these roles through (else 403)
// Only then does createShop run.
router.post("/", auth, requireRole("seller", "admin"), asyncHandler(createShop));

module.exports = router;
