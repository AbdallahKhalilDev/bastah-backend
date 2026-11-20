const mongoose = require("mongoose");
const { DEFAULT_PRODUCT_IMAGE } = require("../utils/productImages");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Product — the CANONICAL catalog item, i.e. one document
// per real-world thing (e.g. "1kg white sugar"). It is deliberately NOT a price
// and NOT tied to a single shop.
//
// The whole point of Bastah is comparing one product's price across many shops.
// We get that by splitting two ideas apart:
//   - Product (this file) = the shared item, stored once.
//   - Listing (next slice) = one shop's price for one product.
// Many Listings can point at the SAME Product, and that shared product id is
// what lets us later ask "show me every shop that sells this, cheapest first"
// with a single clean query instead of fragile name-matching.
const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true, // strips surrounding spaces so " Sugar " is saved as "Sugar"
    },
    // The app is bilingual, so every product carries an Arabic name too.
    nameAr: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional free-text details (e.g. "Refined white cane sugar, 1kg bag").
    description: {
      type: String,
      trim: true,
    },
    // Which category this product belongs to. A "reference" field: we store just
    // the Category's _id and tell Mongoose it points at a Category (ref:
    // "Category") — like a foreign key. Later we can .populate("category") to
    // swap the id for the full category document. Required, because every
    // catalog item is filed under exactly one category (used for browse/filter).
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    // How the product is sold/measured, e.g. "kg", "L", "piece". Optional, and
    // it's just a label — it doesn't change how the price number is stored.
    unit: {
      type: String,
      trim: true,
    },
    // ONE generic image per product, shared by every shop that sells it (a Listing
    // has no image of its own). Always a RELATIVE path to a file served from
    // public/images/products/, e.g. "/images/products/football.webp".
    // The default is the "no photo yet" placeholder, so a brand-new product shows
    // something sensible immediately. `npm run seed:product-images` swaps in the
    // real photo once a matching file is added. Clients can't set this field: it's
    // kept out of the create whitelist, so it stays a path we control.
    imageUrl: {
      type: String,
      trim: true,
      default: DEFAULT_PRODUCT_IMAGE,
    },
    // Whether this product is "featured" on the Home page. This is an
    // EDITORIAL / admin-only flag, exactly like a shop's `isVerified`: a seller
    // must not be able to promote their own product to the front page, so it's
    // NOT part of the create/update whitelist and can only be flipped via the
    // admin-only `PATCH /api/products/:id/feature` route. Defaults to false, so
    // every product starts un-featured.
    isFeatured: {
      type: Boolean,
      default: false,
    },
    // false = HIDDEN by an admin: gone from every customer page (browse, search,
    // home, product page, price comparison, a shop's items), can't be listed by
    // a shop again, and can't be checked out. Never deleted, because listings,
    // carts and old orders point at it. Set ONLY with the admin-only
    // PATCH /api/admin/products/:id/active.
    //
    // Products made before this field have nothing stored, so public reads
    // filter with VISIBLE_PRODUCT ({ isActive: { $ne: false } } = "not hidden")
    // rather than { isActive: true }, which would skip all of them.
    isActive: {
      type: Boolean,
      default: true,
    },
    // Who added this product to the catalog (set by POST /api/products from the
    // token, never from the body). It decides who may EDIT it: the seller who
    // created it, until another seller's shop sells it too (see
    // utils/productRules.js). Admins can always edit.
    //
    // Products made before this field existed have nothing stored. The default
    // null means "creator unknown", so only an admin can edit those.
    //
    // NEW CONCEPT: `select: false`. Mongoose leaves this field OUT of every
    // query's result unless a query asks for it by name with
    // .select("+createdBy"). So the many public product reads (browse, search,
    // home, product page…) never reveal who created what, without changing any
    // of them. It's the schema-level version of .select("-passwordHash").
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      select: false,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// A "model" is the tool we use to actually read/write Products in the database.
// Mongoose will use the collection named "products" (lowercased + pluralized).
module.exports = mongoose.model("Product", productSchema);
