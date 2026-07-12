const mongoose = require("mongoose");
const { z } = require("zod");
const Review = require("../models/Review");
const Shop = require("../models/Shop");
const parsePagination = require("../utils/pagination");

// --- Input validation ---------------------------------------------------
// A WHITELIST for creating a review. Only these two keys are accepted; zod strips
// anything else. Notice what is NOT here: `author` and `shop`. The author comes
// from the login token, and the shop comes from the URL (:shopId) — never from
// the body — so a client can't post a review "as" someone else or aimed at a
// different shop. `rating` must be a whole number 1–5; `comment` is optional.
const createReviewSchema = z.object({
  rating: z
    .number()
    .int("Rating must be a whole number")
    .min(1, "Rating must be at least 1")
    .max(5, "Rating must be at most 5"),
  comment: z.string().optional(),
});

// A WHITELIST for UPDATING a review. Same two fields, but BOTH optional — a PATCH
// changes only what you send. Notice what's NOT here: `author` and `shop`. zod
// strips them, so even if a client sends them we ignore them — a review can never
// be repointed at a different author or shop (same reasoning as the locked
// shop/product on a Listing update).
const updateReviewSchema = z.object({
  rating: z
    .number()
    .int("Rating must be a whole number")
    .min(1, "Rating must be at least 1")
    .max(5, "Rating must be at most 5")
    .optional(),
  comment: z.string().optional(),
});

// --- The shared rating helper -------------------------------------------
// recalcShopRating recomputes a shop's cached ratingAvg/ratingCount FROM the
// actual reviews and saves the result onto the shop. It is the ONE place the
// rating is ever updated, and Slices 2 and 4 both call it (after a review is
// created, edited, or deleted).
//
// WHY recompute from the source instead of nudging the old numbers with a formula
// like (oldAvg * oldCount + newRating) / (oldCount + 1)? Because that incremental
// trick only works for ADDING. The moment a review is edited or deleted, the old
// numbers no longer describe reality and the formula silently drifts. The reviews
// collection is the single source of truth; recomputing from it is always correct,
// no matter what changed. And because every code path funnels through this ONE
// function, the rating can only ever be updated the one correct way — there's no
// second, subtly-different copy of the math to fall out of sync.
async function recalcShopRating(shopId) {
  // Aggregation = a mini data-processing pipeline that runs INSIDE MongoDB.
  //   $match  → keep only this shop's reviews
  //   $group  → collapse them into a single summary row: how many (count) and
  //             their average rating (avg)
  const [summary] = await Review.aggregate([
    { $match: { shop: new mongoose.Types.ObjectId(shopId) } },
    { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: "$rating" } } },
  ]);

  // No reviews left → aggregate returns nothing, so summary is undefined. In that
  // case the shop resets to 0 / 0 (this is what makes "delete the last review"
  // return the shop cleanly to zero in Slice 4).
  const count = summary ? summary.count : 0;
  // Round the average to ONE decimal place (4.6666… → 4.7). Math.round works on
  // whole numbers, so we scale up by 10, round, then scale back down.
  const avg = summary ? Math.round(summary.avg * 10) / 10 : 0;

  await Shop.findByIdAndUpdate(shopId, {
    ratingCount: count,
    ratingAvg: avg,
  });
}

// POST /api/shops/:shopId/reviews
// Protected: a logged-in CUSTOMER only (auth + requireRole("customer") run first,
// in the route). Creates one review for one shop and refreshes the shop's rating.
async function createReview(req, res, next) {
  // 1. Guard the shop id from the URL FIRST (else findById would throw a
  //    CastError on junk like "abc"). A malformed id is a 400.
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Load the shop and make sure it's real AND visible. We hide inactive shops
  //    with a 404, exactly like the public reads — a customer shouldn't be able
  //    to review a shop they can't even see.
  const shop = await Shop.findById(req.params.shopId);
  if (!shop || !shop.isActive) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Validate the body against the whitelist.
  const result = createReviewSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 4. Create the review. CRITICAL: author comes from the verified token
  //    (req.user.id), and shop from the URL — never the body. The unique
  //    (author, shop) index means a SECOND review by this customer for this shop
  //    is rejected by MongoDB with error code 11000; we catch exactly that and
  //    return a friendly 409. Any other error goes to the central handler (500).
  let review;
  try {
    review = await Review.create({
      author: req.user.id,
      shop: req.params.shopId,
      rating: data.rating,
      comment: data.comment,
    });
  } catch (err) {
    if (err.code === 11000) {
      return next({
        status: 409,
        message: "You have already reviewed this shop",
      });
    }
    return next(err);
  }

  // 5. Now that a new review exists, recompute the shop's cached rating from ALL
  //    its reviews (this new one included) and save it onto the shop.
  await recalcShopRating(req.params.shopId);

  // 6. Respond 201 (Created) with the review we just made.
  res.status(201).json({ review });
}

// GET /api/shops/:shopId/reviews
// Public (no auth). Returns a shop's reviews, newest first, in PAGES — this feeds
// the reviews section on a shop's profile page.
async function listShopReviews(req, res, next) {
  // 1. Guard the shop id from the URL (else find would throw a CastError on junk).
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Make sure the shop exists → 404 if not. (The spec asks only for "missing"
  //    here, so we don't hide inactive shops on this read.)
  const shop = await Shop.findById(req.params.shopId);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Turn ?page / ?limit into trustworthy numbers (+ the skip offset), the same
  //    way the product browse/search endpoints do.
  const { page, limit, skip } = parsePagination(req.query);

  // 4. countDocuments is a separate, cheap query: how many reviews this shop has
  //    in TOTAL (across all pages), so a frontend can show "page 1 of N".
  const total = await Review.countDocuments({ shop: req.params.shopId });

  // 5. The actual page: this shop's reviews, newest first, jump over `skip`, take
  //    `limit`. CRITICAL for privacy: populate the author with ONLY their name —
  //    the second argument is a whitelist, so email/passwordHash can never leak
  //    on this public endpoint. A shop with no reviews simply gives back [] (200).
  const reviews = await Review.find({ shop: req.params.shopId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate("author", "name");

  res.json({ reviews, page, limit, total });
}

// PATCH /api/reviews/:id
// Protected (auth). Only the review's OWN author may edit it, and only the rating
// and comment can change. After saving, we recompute the shop's rating with the
// same helper Slice 2 uses.
async function updateReview(req, res, next) {
  // 1. Guard the id from the URL (else findById throws a CastError on junk).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid review id" });
  }

  // 2. Load the review. A well-formed id matching nothing is a 404.
  const review = await Review.findById(req.params.id);
  if (!review) {
    return next({ status: 404, message: "Review not found" });
  }

  // 3. Ownership: only the author may edit their own review. (No admin override
  //    on EDIT — an admin shouldn't rewrite someone's opinion; deleting abuse is
  //    a separate power, handled below.) author is an ObjectId, so .toString() to
  //    compare it to the string id from the token.
  if (review.author.toString() !== req.user.id) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body against the update whitelist. shop/author aren't in it,
  //    so they can't be changed here.
  const result = updateReviewSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. Copy the validated fields onto the document and save. save() runs the
  //    schema validators and refreshes updatedAt.
  Object.assign(review, data);
  await review.save();

  // 6. The rating may have changed, so recompute the shop's cached rating from
  //    ALL its reviews — the SAME helper as Slice 2, so the math lives in one
  //    place and can't drift.
  await recalcShopRating(review.shop);

  res.json({ review });
}

// DELETE /api/reviews/:id
// Protected (auth). The author may delete their own review; an ADMIN may delete
// anyone's (to remove abuse). After deleting, we re-sync the shop's rating.
async function deleteReview(req, res, next) {
  // 1. Same id guard → 400.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid review id" });
  }

  // 2. Load the review → 404 if it's not there.
  const review = await Review.findById(req.params.id);
  if (!review) {
    return next({ status: 404, message: "Review not found" });
  }

  // 3. Ownership: allowed if you're an admin OR you're the author. Otherwise 403.
  if (req.user.role !== "admin" && review.author.toString() !== req.user.id) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Remember which shop this review belonged to BEFORE we delete it — we still
  //    need that id to recompute the shop's rating afterwards.
  const shopId = review.shop;
  await review.deleteOne();

  // 5. Re-sync the shop's rating from whatever reviews remain. If this was the
  //    LAST review, the aggregation returns nothing and recalcShopRating resets
  //    the shop to ratingCount 0 / ratingAvg 0 — exactly what we want.
  await recalcShopRating(shopId);

  res.json({ message: "Review deleted" });
}

module.exports = {
  recalcShopRating,
  createReview,
  listShopReviews,
  updateReview,
  deleteReview,
};
