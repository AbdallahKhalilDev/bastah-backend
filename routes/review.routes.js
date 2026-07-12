const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const {
  updateReview,
  deleteReview,
} = require("../controllers/review.controller");

const router = express.Router();

// Thin routes: map the URL to the controller.
//
// Note: CREATE lives under the shop (POST /api/shops/:shopId/reviews) because a
// new review needs a shop to attach to. But once a review exists it has its own
// id, so editing and deleting it are addressed directly here at /api/reviews/:id.
//
// Both require only `auth` (any logged-in user) — there's no requireRole here.
// The finer rule (edit = author only; delete = author or admin) needs the review
// document to know its author, so it's enforced INSIDE the controller.
router.patch("/:id", auth, asyncHandler(updateReview));
router.delete("/:id", auth, asyncHandler(deleteReview));

module.exports = router;
