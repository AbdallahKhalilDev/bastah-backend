const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  getCart,
  addItem,
  setItemQuantity,
  removeItem,
  clearCart,
} = require("../controllers/cart.controller");

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

// Add a listing to my cart (or bump its quantity if it's already there).
router.post("/items", auth, requireRole("customer"), asyncHandler(addItem));

// Set one item's quantity outright. The URL param is the LISTING id (that's what
// identifies a cart line — items have no id of their own).
router.patch(
  "/items/:listingId",
  auth,
  requireRole("customer"),
  asyncHandler(setItemQuantity)
);

// Remove one item from my cart.
router.delete(
  "/items/:listingId",
  auth,
  requireRole("customer"),
  asyncHandler(removeItem)
);

// Empty my whole cart. A one-segment path, so it never clashes with the
// two-segment /items/:listingId routes above.
router.delete("/", auth, requireRole("customer"), asyncHandler(clearCart));

module.exports = router;
