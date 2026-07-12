const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Cart — the "add to cart" basket that belongs to ONE
// customer. There is exactly one cart per customer (see the `unique` on
// `customer` below), and it holds a list of items the customer is interested in.
//
// The KEY design choice for Bastah: a cart item points at a LISTING, not a bare
// Product. A Listing is "one shop's price for one product." So "add to cart"
// means "this shop's version of the product, at this shop's price" — which is
// exactly what a shopper picked while comparing prices across shops. Because each
// item references a listing (and a listing already knows its shop + price), a
// single cart can naturally hold items from several different shops at once, and
// that's fine.
//
// Notice what we DON'T store on an item: the price. We deliberately keep only
// { listing, quantity }. Prices in Bastah change daily, and a cart is NOT a
// committed order — it's a live shortlist. When we read the cart we populate the
// listing fresh, so the customer always sees the CURRENT price. (Freezing a price
// into a "priceAtOrder" snapshot is a job for the Order model, which we are not
// building now.)

// --- The item subdocument -----------------------------------------------
// This little schema describes ONE line in the cart. We define it separately
// only to keep things readable; it does not get its own collection. `_id: false`
// tells Mongoose not to give each item its own extra id — we don't need one,
// because an item is identified by WHICH LISTING it points at (a listing can
// appear at most once in a cart; adding the same listing again bumps its
// quantity in Slice 3 rather than creating a duplicate line).
const cartItemSchema = new mongoose.Schema(
  {
    // Which listing this line refers to. A reference (foreign key) to a Listing.
    // Required — an item with no listing is meaningless. When we read the cart we
    // .populate() this to pull in the live price, product, and shop.
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
    },
    // How many of it the customer wants. A whole number, at least 1 (you can't
    // want zero or half of something). `min`/`validate` are the database-level
    // safety net behind the zod check in the controller — the same "belt and
    // braces" idea as `price: { min: 0 }` on the Listing model. Defaults to 1 so
    // "add to cart" without a quantity means "one, please."
    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number",
      },
    },
  },
  // No separate _id per item — see the explanation above.
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    // WHOSE cart this is. A reference to a User. Required, and `unique` so a
    // customer can have at most ONE cart — the "one cart per customer" rule,
    // enforced by the database itself (a duplicate insert is rejected with error
    // code 11000, the same mechanism as the unique indexes on Listing/Review).
    // We always find a cart by this field from the LOGIN TOKEN, never from a
    // client-supplied cart id, so a customer can only ever touch their own cart.
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    // --- The embedded subdocument array ---------------------------------
    // `items` is an ARRAY OF SUBDOCUMENTS: the cart lines live INSIDE the cart
    // document itself (embedded), rather than in their own separate "cartitems"
    // collection with references back to the cart.
    //
    // WHY embed them here instead of giving them their own collection? Because a
    // cart item is only ever meaningful as part of its owning cart — you never
    // look up a cart line on its own, you always load "this customer's cart and
    // everything in it." When data is only ever accessed THROUGH its parent and
    // travels with it, embedding is the natural fit: one read (`find the cart`)
    // returns the cart and all its items together, and there are no extra joins
    // to stitch them back on. (Contrast with Listing, which lives in its own
    // collection precisely because many different queries need listings on their
    // own — e.g. "every shop that sells this product.") Each item still holds a
    // reference to a Listing, because listings ARE shared, independent data.
    //
    // Defaults to [] so a brand-new cart simply starts empty.
    items: {
      type: [cartItemSchema],
      default: [],
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// A "model" is the tool we use to actually read/write Carts in the database.
// Mongoose will use the collection named "carts" (lowercased + pluralized).
module.exports = mongoose.model("Cart", cartSchema);
