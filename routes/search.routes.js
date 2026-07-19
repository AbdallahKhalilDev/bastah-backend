const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { search } = require("../controllers/search.controller");

const router = express.Router();

// Thin route: one public, read-only endpoint — the global "search everything" box.
// A single "/" route (no "/:id"), so there's no route-ordering concern here.
// asyncHandler forwards any thrown/rejected error to our central errorHandler.
router.get("/", asyncHandler(search));

module.exports = router;
