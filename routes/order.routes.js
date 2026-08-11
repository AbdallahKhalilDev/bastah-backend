const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  createOrder,
  listMyOrders,
  listIncomingOrders,
  getOrder,
  updateOrderStatus,
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

// The seller's inbox: every order placed at any shop I own.
//
// ⚠ ROUTE ORDER: this MUST stay ABOVE `GET /:id`. Express matches routes in the
// order they're registered, and `/:id` happily matches any single segment — so
// if it came first, a request for /api/orders/incoming would be read as
// "the order whose id is 'incoming'" and answer 400 "Invalid order id" for a
// URL that looks perfectly correct. Same rule as /api/shops/top and
// /api/products/featured.
router.get(
  "/incoming",
  auth,
  requireRole("seller", "admin"),
  asyncHandler(listIncomingOrders)
);

// One order in detail.
//
// NOTE: `auth` but NO requireRole. Three different kinds of user may read an
// order — the customer who placed it, the seller who owns its shop, or an
// admin — and which one you are depends on the ORDER, not on your role alone.
// So the check lives in the controller (resolveActorRole), exactly like
// PATCH /api/reviews/:id decides author-ownership there.
router.get("/:id", auth, asyncHandler(getOrder));

// Move an order along its lifecycle (accept it, mark it ready, complete it,
// cancel it). Also `auth` with no requireRole, for the same reason: a customer
// may cancel their own pending order, the shop's owner may do the rest, and the
// full rule book lives in the TRANSITIONS table in utils/orderQueries.js.
//
// Two segments, so this never collides with the one-segment `/:id` above.
router.patch("/:id/status", auth, asyncHandler(updateOrderStatus));

module.exports = router;
