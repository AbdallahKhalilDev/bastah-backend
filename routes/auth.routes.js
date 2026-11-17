const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const {
  register,
  registerSeller,
  loginAs,
  me,
} = require("../controllers/auth.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller. All the real logic lives in
// the controller. asyncHandler forwards any thrown/rejected error to our
// central errorHandler.

// Sign-up. The role is decided by WHICH URL is called, never by the body:
//   /register        → a customer
//   /seller/register → a seller, together with their first shop
// There is NO admin sign-up route at all: new admins are created by an
// existing admin.
router.post("/register", asyncHandler(register));
router.post("/seller/register", asyncHandler(registerSeller));

// One login endpoint per login page. Each accepts ONLY its own kind of account
// (see loginAs in the controller); the wrong page answers 403 "wrong_portal".
router.post("/login", asyncHandler(loginAs("customer")));
router.post("/seller/login", asyncHandler(loginAs("seller")));
router.post("/admin/login", asyncHandler(loginAs("admin")));

// Protected route: `auth` runs FIRST. Only a request with a valid token gets
// past it (otherwise 401), and it sets req.user for the `me` controller to use.
// Every role uses this same /me.
router.get("/me", auth, asyncHandler(me));

module.exports = router;
