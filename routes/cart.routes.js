const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { getCart } = require("../controllers/cart.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.
//
// EVERY cart route is gated the same way, left-to-right BEFORE the controller:
//   auth                      → verifies the token, sets req.user (else 401)
//   requireRole("customer")   → allows only customers through (else 403)
// The controller then resolves the cart from req.user.id, so a customer can only
// ever see or touch their OWN cart — the cart id never comes from the client.

// View my cart.
router.get("/", auth, requireRole("customer"), asyncHandler(getCart));

module.exports = router;
