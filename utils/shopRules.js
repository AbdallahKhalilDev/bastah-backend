// The ONE description of what a valid shop looks like.
//
// Four endpoints accept shop details:
//   POST  /api/shops                  (a seller adds a shop from the dashboard)
//   PATCH /api/shops/:id              (a seller edits their shop)
//   POST  /api/auth/seller/register   (a new seller signs up WITH their first shop)
//   POST  /api/admin/users/:id/shops  (an admin adds a shop for a seller)
// They all build on these rules, so a shop can never be valid in one place and
// invalid in another.
const mongoose = require("mongoose");
const { z } = require("zod");
const Category = require("../models/Category");
const Shop = require("../models/Shop");

// Field by field. This is a WHITELIST: zod drops any key that isn't listed, so a
// client that sends owner / isVerified / ratingAvg / ratingCount can never get
// them into the database. `owner` always comes from the login token.
//
// `.trim()` runs first, so "  Abu Ali Store  " becomes "Abu Ali Store" and a name
// of only spaces counts as empty. Every text field has a maximum length, so
// nobody can store a giant text in our database.
//
// `{ error: "..." }` on z.string() is the message for a field that is MISSING
// altogether; the message in .min(1, "...") is for one that is present but empty.
const shopFields = {
  name: z
    .string({ error: "Shop name is required" })
    .trim()
    .min(1, "Shop name is required")
    .max(100, "Shop name is too long (max 100 characters)"),
  phone: z
    .string({ error: "Shop phone is required" })
    .trim()
    .min(1, "Shop phone is required")
    .max(20, "Shop phone is too long (max 20 characters)"),
  area: z.string().trim().max(100, "Area is too long (max 100 characters)").optional(),
  address: z.string().trim().max(200, "Address is too long (max 200 characters)").optional(),
  description: z
    .string()
    .trim()
    .max(1000, "Description is too long (max 1000 characters)")
    .optional(),
  logoUrl: z.string().trim().max(500, "Logo URL is too long").optional(),
  category: z.string().optional(),
};

// POST /api/shops: name and phone required, everything else optional. The owner
// may also choose to create the shop hidden (isActive: false).
const createShopSchema = z.object({
  ...shopFields,
  isActive: z.boolean().optional(),
});

// PATCH /api/shops/:id: the same fields, but EVERY one optional, because a PATCH
// changes only what you send. `.partial()` does exactly that. A field that IS sent
// still has to pass its rules, so name/phone can't be blanked out.
const updateShopSchema = createShopSchema.partial();

// Seller sign-up: the shop part of the form. Differences from POST /api/shops:
//  - phone is optional. Left out, the shop uses the seller's own phone, so they
//    don't have to type the same number twice.
//  - no isActive: a brand-new shop always starts visible.
const signupShopSchema = z.object(
  { ...shopFields, phone: shopFields.phone.optional() },
  { error: "Shop details are required" }
);

// Checks a category id sent by the client. Returns an error MESSAGE when it's
// bad, or null when it's fine (or wasn't sent at all, since category is optional).
// Both problems are the client's bad input, so the caller answers 400.
//
// Only `undefined` means "not sent". An empty string "" IS sent, and is not a
// valid id, so it gets "Invalid category id" (before, it reached the database
// and came back as a 500).
async function checkCategory(categoryId) {
  if (categoryId === undefined) return null;

  // Check the id is well-formed first, or Mongoose would throw a CastError.
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return "Invalid category id";
  }
  const exists = await Category.exists({ _id: categoryId });
  if (!exists) {
    return "Category not found";
  }
  return null;
}

// Creates a shop for `ownerId` from a request body, after the same checks every
// time. Returns { problem } (pass it to next()) or { shop }, like createAccount().
//
// Two endpoints add a shop, and both call this, so they can't drift apart:
//   POST /api/shops                  a seller adds a shop; owner = the caller
//   POST /api/admin/users/:id/shops  an admin adds one FOR a seller
// `ownerId` always comes from the server (the token, or the URL the admin
// chose), never from the body: the whitelist drops a body `owner`, so nobody
// can create a shop in someone else's name.
async function createShopFor(ownerId, body) {
  const result = createShopSchema.safeParse(body);
  if (!result.success) {
    return { problem: { status: 400, message: result.error.issues[0].message } };
  }
  const data = result.data;

  const categoryProblem = await checkCategory(data.category);
  if (categoryProblem) {
    return { problem: { status: 400, message: categoryProblem } };
  }

  const shop = await Shop.create({ ...data, owner: ownerId });
  return { shop };
}

// The ONE description of how a shop's delivery zones are populated for a read
// (each zone's area id → its name). The public shop pages AND the seller
// dashboard use it, so the two can't show zones in different shapes.
const ZONE_POPULATE = { path: "deliveryZones.area", select: "name nameAr slug" };

module.exports = {
  createShopSchema,
  updateShopSchema,
  signupShopSchema,
  checkCategory,
  createShopFor,
  ZONE_POPULATE,
};
