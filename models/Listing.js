const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Listing — ONE shop's price for ONE product. It is the
// bridge between the two things we deliberately kept apart:
//   Shop      (who is selling)
//   Product   (the canonical item, e.g. "1kg white sugar")
//   Listing   (this: "Shop A sells that product for ₪5, in stock")
//
// Because many Listings can point at the SAME product, we can later gather every
// shop that sells a product and sort them cheapest-first — that's the whole
// price-comparison feature, and it's why Listing exists as its own collection.
const listingSchema = new mongoose.Schema(
  {
    // Which shop this price belongs to. A reference (foreign key) to a Shop.
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },
    // Which product this price is FOR. A reference to a Product. This shared id
    // is what makes two shops' listings comparable.
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    // The price in Israeli Shekels (₪ / ILS) — just a plain number, no currency
    // symbol stored. min: 0 rejects negative prices at the database level, a
    // safety net behind the zod check in the controller.
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    // Whether the shop currently has it. Defaults to true so a new listing is
    // assumed available unless the seller says otherwise.
    inStock: {
      type: Boolean,
      default: true,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// --- Compound UNIQUE index on (shop, product) ---------------------------
// An "index" is a lookup structure the database keeps on the side to find
// documents fast. A "compound" index covers TWO fields together, and marking it
// `unique` tells MongoDB: no two documents may share the SAME COMBINATION of
// shop + product. So one shop can list many different products, and one product
// can be listed by many different shops — but a single shop can list a given
// product at most ONCE.
//
// Why it matters for Bastah: price comparison shows "each shop that sells this
// product, once, with its price." If a shop could create five listings for the
// same product, that shop would show up five times with five prices and the
// comparison would be meaningless. This index makes the "one price per product
// per shop" rule impossible to break — the database itself enforces it.
//
// When the controller tries to insert a duplicate pair, MongoDB rejects it with
// error code 11000 ("duplicate key"); we catch that and return a friendly 409
// instead of a 500. Mongoose builds this index automatically on startup in
// development.
listingSchema.index({ shop: 1, product: 1 }, { unique: true });

// A "model" is the tool we use to actually read/write Listings in the database.
// Mongoose will use the collection named "listings" (lowercased + pluralized).
module.exports = mongoose.model("Listing", listingSchema);
