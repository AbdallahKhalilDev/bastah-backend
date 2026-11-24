const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { listCurrentOffers } = require("../controllers/offer.controller");

const router = express.Router();

// Public: every current offer from an open shop, newest first (?page= ?limit=).
// Posting and editing offers live on the dashboards: /api/seller/offers and
// /api/admin/offers. One shop's offers: GET /api/shops/:shopId/offers.
router.get("/", asyncHandler(listCurrentOffers));

module.exports = router;
