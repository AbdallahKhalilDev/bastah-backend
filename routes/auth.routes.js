const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const { register, login, me } = require("../controllers/auth.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller. All the real logic lives in
// the controller. asyncHandler forwards any thrown/rejected error to our
// central errorHandler.
router.post("/register", asyncHandler(register));
router.post("/login", asyncHandler(login));

// Protected route: `auth` runs FIRST. Only a request with a valid token gets
// past it (otherwise 401), and it sets req.user for the `me` controller to use.
router.get("/me", auth, asyncHandler(me));

module.exports = router;
