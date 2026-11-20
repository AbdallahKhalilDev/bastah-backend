// The ONE description of a valid product, and of WHO may edit one.
//
// A Product is a SHARED catalog entry ("Sugar 1kg"): every shop that sells
// sugar points its own listing (its price) at the same product. That's what
// makes the price comparison work, and it's why editing a product is
// restricted. Renaming it changes it for EVERY shop that sells it.
//
// The rule (agreed 2026-11-18):
//   - an admin may always edit a product;
//   - the seller who CREATED it may edit it while no OTHER seller's shop sells it
//     (so they can fix a typo right after adding it);
//   - once another seller lists it, it's shared, and only an admin can change it;
//   - a product with no creator stored (made before we recorded it) → admins only.
// A seller's own price and stock are a different thing (the Listing), and they
// can always edit those.
const { z } = require("zod");
const Listing = require("../models/Listing");
const { getMyShopIds } = require("./sellerQueries");

// Field by field. A WHITELIST: anything not listed (imageUrl, isFeatured,
// createdBy…) is dropped by zod, so a client can never set those. The image is
// set only by the image script, featuring only by an admin, and the creator only
// by the server.
const productFields = {
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(1, "Name is required")
    .max(100, "Name is too long (max 100 characters)"),
  nameAr: z
    .string({ error: "Arabic name is required" })
    .trim()
    .min(1, "Arabic name is required")
    .max(100, "Arabic name is too long (max 100 characters)"),
  description: z
    .string()
    .trim()
    .max(1000, "Description is too long (max 1000 characters)")
    .optional(),
  // Checked against the database by checkCategory() (in shopRules.js).
  category: z.string({ error: "Category is required" }).min(1, "Category is required"),
  unit: z.string().trim().max(30, "Unit is too long (max 30 characters)").optional(),
};

// POST /api/products: name, nameAr and category are required.
const createProductSchema = z.object(productFields);

// PATCH /api/products/:id: every field optional (send only what changes), with
// exactly the same rules for the ones you do send.
const updateProductSchema = z.object(productFields).partial();

const NOT_YOURS = {
  status: 403,
  message: "You can only edit products you added",
};
const SHARED = {
  status: 403,
  code: "product_shared",
  message: "Other shops sell this product. Ask an admin to change it",
};

// May this user edit this product? Returns null (yes) or a problem for next().
// `product` must have been loaded WITH its creator: .select("+createdBy").
async function checkCanEditProduct(product, user) {
  if (user.role === "admin") {
    return null;
  }

  // Not the creator, or nobody recorded → not yours. (createdBy is an ObjectId,
  // the id from the token is a string, so compare as strings.)
  if (!product.createdBy || product.createdBy.toString() !== user.id) {
    return NOT_YOURS;
  }

  // Is it listed by a shop that ISN'T mine? $nin = "not in this list". The
  // seller's OWN shops don't count: listing it in their second shop doesn't make
  // it "shared". Closed shops of other sellers DO count: they still point at it.
  const myShopIds = await getMyShopIds(user.id);
  const shared = await Listing.exists({ product: product._id, shop: { $nin: myShopIds } });
  return shared ? SHARED : null;
}

// For a LIST of products a seller created: which of them are shared already?
// Returns a Set of product id strings. One query for the whole page instead of
// one per product.
//
// NEW CONCEPT: distinct("product", filter) returns each DIFFERENT value of one
// field among the matching documents, once. Here: "the products, out of these,
// that some other seller's shop lists".
async function sharedProductIds(productIds, sellerId) {
  const myShopIds = await getMyShopIds(sellerId);
  const ids = await Listing.distinct("product", {
    product: { $in: productIds },
    shop: { $nin: myShopIds },
  });
  return new Set(ids.map((id) => id.toString()));
}

module.exports = {
  createProductSchema,
  updateProductSchema,
  checkCanEditProduct,
  sharedProductIds,
};
