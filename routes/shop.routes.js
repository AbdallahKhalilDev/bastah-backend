const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { listShops, getShop } = require("../controllers/shop.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller. Both are public (no auth).
// asyncHandler forwards any thrown/rejected error to our central errorHandler.
router.get("/", asyncHandler(listShops));
router.get("/:id", asyncHandler(getShop));

module.exports = router;
