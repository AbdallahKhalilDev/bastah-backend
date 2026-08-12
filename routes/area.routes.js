const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { listAreas } = require("../controllers/area.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.

// The fixed list of Gaza areas. Public — the checkout picker and the seller's
// delivery settings both need it, and there's nothing private about a place name.
router.get("/", asyncHandler(listAreas));

module.exports = router;
