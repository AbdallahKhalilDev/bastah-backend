const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { getHome } = require("../controllers/home.controller");

const router = express.Router();

// Thin route: one public, read-only endpoint that bundles the three Home-page
// strips (featured, new arrivals, top stores) into a single response.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.
router.get("/", asyncHandler(getHome));

module.exports = router;
