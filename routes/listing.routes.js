const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const {
  updateListing,
  deleteListing,
} = require("../controllers/listing.controller");

const router = express.Router();

// Thin routes: map the URL to the controller. Both are protected the same way
// as creating a listing (auth → seller/admin); the per-shop ownership rule
// (only the shop's owner, or an admin, may edit/delete) is enforced inside the
// controller, because it must load the listing's shop to know the owner.
//
// Note: CREATE lives under the shop (POST /api/shops/:shopId/listings) because a
// new listing needs a shop to attach to. But once a listing exists it has its
// own id, so editing and deleting it are addressed directly here at
// /api/listings/:id.
router.patch("/:id", auth, requireRole("seller", "admin"), asyncHandler(updateListing));
router.delete("/:id", auth, requireRole("seller", "admin"), asyncHandler(deleteListing));

module.exports = router;
