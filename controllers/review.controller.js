const mongoose = require("mongoose");
const { z } = require("zod");
const Review = require("../models/Review");
const Shop = require("../models/Shop");

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

module.exports = { recalcShopRating, createReview };
