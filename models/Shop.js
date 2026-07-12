const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Shop — a local store that a seller runs on the
// marketplace. Customers browse shops, and each shop will later hold "listings"
// (its own prices for products). For now we only model the shop itself.
const shopSchema = new mongoose.Schema(
  {
    // Who owns this shop. A "reference" field: we store just the User's _id and
    // tell Mongoose it points at a User (ref: "User") — like a foreign key.
    // Later we can .populate("owner") to swap the id for the real user doc.
    // NOTE: no `unique` here on purpose — one seller may own MANY shops.
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true, // strips surrounding spaces so " Abu Ali Store " → "Abu Ali Store"
    },
    // How customers contact the shop. Required because the whole point of the
    // app is connecting a customer to a seller (there's no in-app payment).
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    // The neighbourhood / district (e.g. "Rimal"). Optional — no `required`.
    area: {
      type: String,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    logoUrl: {
      type: String,
      trim: true,
    },
    // Which category this shop mainly belongs to. Another reference, this time to
    // a Category. Optional, and default null means "no category chosen yet."
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    // Lets us hide a shop from shoppers without actually deleting it.
    isActive: {
      type: Boolean,
      default: true,
    },
    // Set by us/admins once we've confirmed the shop is a real, trusted store.
    // A seller can NEVER flip this on themselves — it's system-controlled.
    isVerified: {
      type: Boolean,
      default: false,
    },

    // --- Denormalized rating fields -------------------------------------
    // Reviews live in their own collection (built later, Step 7). Instead of
    // scanning and averaging EVERY review each time we show a shop, we keep a
    // running summary right here on the shop:
    //   ratingAvg   = the average star rating (e.g. 4.5)
    //   ratingCount = how many reviews that average is based on
    // "Denormalized" just means we store this derived answer directly rather
    // than recomputing it from the source rows on every read. The win: showing
    // a shop's rating (and sorting "top stores") is one instant lookup. The
    // cost: whenever a review is added or changed, we must remember to update
    // these two numbers, or the cached copy will drift from the real reviews.
    // They start at 0 and are system-managed — never set by the client.
    ratingAvg: {
      type: Number,
      default: 0,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// A "model" is the tool we use to actually read/write Shops in the database.
// Mongoose will use the collection named "shops" (lowercased + pluralized).
module.exports = mongoose.model("Shop", shopSchema);
