// The admin dashboard's OVERVIEW: the site-wide number cards, and every review
// in the marketplace (to spot and remove abusive ones).
//
// Every route here is admin-only. That's enforced ONCE, in
// routes/admin.routes.js (router.use), so these functions don't repeat it.
const mongoose = require("mongoose");
const Review = require("../models/Review");
const parsePagination = require("../utils/pagination");
const escapeRegex = require("../utils/escapeRegex");
const { getOrderStats, getListingStats, getSiteCounts } = require("../utils/statsQueries");

// GET /api/admin/stats
// The number cards for the whole marketplace:
//   { users, shops, products, reviews, orders, completedValue, topProducts, listings }
//
// orders / completedValue / topProducts / listings come from the SAME functions
// as the seller's GET /api/seller/stats, called with an empty filter {} ("every
// shop") instead of "my shops". So a seller's numbers and the admin's numbers
// are always counted the same way, the same idea as the shared order inbox.
async function getSiteStats(req, res) {
  const [counts, orderStats, listings] = await Promise.all([
    getSiteCounts(),
    getOrderStats({}),
    getListingStats({}),
  ]);

  res.json({ ...counts, ...orderStats, listings });
}

// GET /api/admin/reviews
// Every review in the marketplace, newest first, paginated, with the author's
// name AND email (the public review list shows the name only) and the shop's
// name. Removing one is the existing DELETE /api/reviews/:id, which an admin
// may call on any review, and which keeps the shop's rating in sync.
// Admins don't EDIT reviews: the words are shown under the customer's name.
// Optional filters (they combine):
//   ?shop=<id>     one shop's reviews
//   ?rating=1..5   only reviews with that many stars (e.g. the 1-star ones)
//   ?q=text        the comment contains this text
async function listAllReviews(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  if (req.query.shop) {
    if (!mongoose.Types.ObjectId.isValid(req.query.shop)) {
      return next({ status: 400, message: "Invalid shop id" });
    }
    filter.shop = req.query.shop;
  }

  if (req.query.rating) {
    // Number("4.5") is 4.5 and Number("abc") is NaN; isInteger rejects both.
    const rating = Number(req.query.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return next({ status: 400, message: "rating must be a whole number from 1 to 5" });
    }
    filter.rating = rating;
  }

  const q = String(req.query.q || "").trim();
  if (q) {
    filter.comment = new RegExp(escapeRegex(q), "i");
  }

  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .populate("author", "name email")
      // isActive, so the screen can show "(closed)" next to the shop.
      .populate("shop", "name isActive"),
    Review.countDocuments(filter),
  ]);

  res.json({ reviews, page, limit, total });
}

module.exports = { getSiteStats, listAllReviews };
