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
} = require("../controllers/admin.controller");

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

module.exports = router;
