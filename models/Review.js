const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Review — ONE customer's star rating (and optional written
// comment) for ONE shop. Reviews target SHOPS, not products: they're how the
// marketplace builds up a seller's reputation, which then shows on Top Stores and
// each shop's profile.
//
// A shop's overall rating is NOT stored here. Instead the Shop document keeps two
// running summary numbers — ratingAvg and ratingCount — that we recompute from
// these reviews whenever one is added/edited/deleted (see review.controller.js).
// That keeps reading a shop's rating a single instant lookup.
const reviewSchema = new mongoose.Schema(
  {
    // WHO wrote the review. A reference (foreign key) to a User. Required — every
    // review must belong to a real, logged-in account. We set this from the login
    // token in the controller, never from the request body, so nobody can post a
    // review "as" someone else.
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // WHICH shop is being reviewed. A reference to a Shop. Required — a review
    // with no target makes no sense.
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    // The star rating, 1 to 5. `min`/`max` reject out-of-range numbers at the
    // database level, and `validate` additionally rejects non-integers (4.5 stars
    // aren't allowed). This is a safety net BEHIND the zod check in the
    // controller — the same "belt and braces" idea as `price: { min: 0 }` on the
    // Listing model: even if a bad value somehow bypassed the controller, the
    // database itself still refuses it.
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
      validate: {
        validator: Number.isInteger,
        message: "Rating must be a whole number from 1 to 5",
      },
    },
    // The written comment. Optional (a customer may leave stars only). `trim`
    // strips surrounding whitespace so "  great!  " is stored as "great!".
    comment: {
      type: String,
      trim: true,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt`. We use
    // `createdAt` to show reviews newest-first.
    timestamps: true,
  }
);

// --- Compound UNIQUE index on (author, shop) ----------------------------
// This MIRRORS the (shop, product) index on the Listing model. A "compound"
// index covers TWO fields together, and marking it `unique` tells MongoDB: no two
// documents may share the SAME COMBINATION of author + shop. So one customer can
// review many different shops, and one shop can be reviewed by many different
// customers — but a single customer can review a given shop at most ONCE.
//
// Why it matters for Bastah: a shop's rating is only trustworthy if each customer
// counts once. Without this rule, one person could post fifty 5-star reviews (or
// fifty 1-star reviews) for the same shop and completely distort its average —
// classic rating spam. This index makes the "one review per customer per shop"
// rule impossible to break, because the database itself enforces it.
//
// When the controller tries to insert a duplicate (author, shop) pair, MongoDB
// rejects it with error code 11000 ("duplicate key"); we catch that and return a
// friendly 409 ("You have already reviewed this shop") instead of a raw 500.
reviewSchema.index({ author: 1, shop: 1 }, { unique: true });

// A "model" is the tool we use to actually read/write Reviews in the database.
// Mongoose will use the collection named "reviews" (lowercased + pluralized).
module.exports = mongoose.model("Review", reviewSchema);
