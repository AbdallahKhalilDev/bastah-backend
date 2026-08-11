const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  createOrder,
  listMyOrders,
  getOrder,
} = require("../controllers/order.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// Turn my cart into orders — one per shop in the cart. Customers only: a seller
// doesn't shop, and this resolves the cart from req.user.id.
// Returns 201 with an ARRAY of orders.
router.post("/", auth, requireRole("customer"), asyncHandler(createOrder));

// My own orders, newest first. Paginated, optional ?status=.
router.get("/", auth, requireRole("customer"), asyncHandler(listMyOrders));

// One order in detail.
//
// NOTE: `auth` but NO requireRole. Three different kinds of user may read an
// order — the customer who placed it, the seller who owns its shop, or an
// admin — and which one you are depends on the ORDER, not on your role alone.
// So the check lives in the controller (resolveActorRole), exactly like
// PATCH /api/reviews/:id decides author-ownership there.
//
// ROUTE ORDER: this is the only `/:id` route here for now. When Slice 12.2 adds
// GET /orders/incoming, that literal path MUST be registered ABOVE this line —
// otherwise Express matches `:id = "incoming"` and answers "Invalid order id"
// for a URL that looks perfectly correct. Same rule as /api/shops/top.
router.get("/:id", auth, asyncHandler(getOrder));

module.exports = router;
