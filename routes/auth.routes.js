const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { register, login } = require("../controllers/auth.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller. All the real logic lives in
// the controller. asyncHandler forwards any thrown/rejected error to our
// central errorHandler.
router.post("/register", asyncHandler(register));
router.post("/login", asyncHandler(login));

module.exports = router;
