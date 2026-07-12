const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const {
  listCategories,
  getCategory,
} = require("../controllers/category.controller");

const router = express.Router();

// Thin routes: just map the URL to the controller. Both are public (no auth).
// asyncHandler forwards any thrown/rejected error to our central errorHandler.
router.get("/", asyncHandler(listCategories));
router.get("/:id", asyncHandler(getCategory));

module.exports = router;
