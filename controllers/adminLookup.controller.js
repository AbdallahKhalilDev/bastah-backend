// The admin dashboard's CATEGORY and AREA screens: list them (hidden ones too),
// add one, rename or hide one.
//
// Categories and areas are the same kind of thing: a small, fixed list that
// admins look after. Each has a name, an Arabic name, a slug, and a shown/hidden
// switch (isActive). So instead of writing the same three endpoints twice, ONE
// "factory" builds them, given what differs: the same idea as loginAs(role) in
// Step 16, which builds a login handler for whichever role you name.
//
// Rules (agreed 2026-11-18):
//   - Hide, never delete: products, shops, delivery zones and orders point at them.
//   - The slug is made from the English name ONCE, when it's created, and never
//     changes after, even on a rename. It's an id-like key that the seed
//     scripts look entries up by.
//   - Two entries can't share a slug → 409.
//
// Every route here is admin-only. That's enforced ONCE, in
// routes/admin.routes.js (router.use), so these functions don't repeat it.
const mongoose = require("mongoose");
const { z } = require("zod");
const Category = require("../models/Category");
const Area = require("../models/Area");
const Product = require("../models/Product");
const Shop = require("../models/Shop");
const slugify = require("../utils/slugify");

// The fields every entry has. A WHITELIST: anything else (slug, _id…) is dropped,
// so the slug can never be set or changed from outside.
const baseFields = {
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
};

// Builds { list, create, update } for one kind of entry.
//   Model        the Mongoose model (Category or Area)
//   label        "Category" / "Area", for messages
//   listKey      the reply key for a list ("categories")
//   itemKey      the reply key for one ("category")
//   extraFields  fields only this kind has (a category's icon)
//   countKey     the name of the usage number in the list ("productCount")
//   countUsage   (ids) → Map of id → how many things use it, so the admin can
//                see what hiding would affect before doing it
function lookupHandlers({ Model, label, listKey, itemKey, extraFields = {}, countKey, countUsage }) {
  const lower = label.toLowerCase();

  // Create: name and nameAr required. Edit: everything optional, plus isActive
  // (hide / show). The SAME rules for the fields both have.
  const createSchema = z.object({ ...baseFields, ...extraFields });
  const updateSchema = createSchema
    .extend({ isActive: z.boolean({ error: "isActive must be true or false" }) })
    .partial();

  // GET /api/admin/<listKey>
  // All of them, hidden ones too, A→Z, each with its usage number. Not paginated:
  // these lists are small and fixed (a few categories, 26 areas).
  async function list(req, res) {
    const items = await Model.find().sort({ name: 1 });
    const counts = await countUsage(items.map((item) => item._id));
    res.json({
      [listKey]: items.map((item) => ({
        ...item.toObject(),
        [countKey]: counts.get(item._id.toString()) || 0,
      })),
    });
  }

  // POST /api/admin/<listKey>
  async function create(req, res, next) {
    const result = createSchema.safeParse(req.body);
    if (!result.success) {
      return next({ status: 400, message: result.error.issues[0].message });
    }
    const data = result.data;

    // "Al-Rimal" → "al-rimal". A name with no English letters or digits at all
    // would give an empty slug, which can't identify anything.
    const slug = slugify(data.name);
    if (!slug) {
      return next({ status: 400, message: "The name needs at least one English letter or number" });
    }

    // A clear 409 for the usual case. (If two admins add the same one at the
    // same moment, the unique index on slug still refuses the second, and the
    // central error handler turns that into a 409 too.)
    if (await Model.exists({ slug })) {
      return next({ status: 409, message: `That name is already used by another ${lower}` });
    }

    const item = await Model.create({ ...data, slug });
    res.status(201).json({ [itemKey]: item });
  }

  // PATCH /api/admin/<listKey>/:id
  // Rename, change the icon, or hide/show ({ isActive: false | true }). The slug
  // stays as it was. Hiding takes it out of the public lists; things already
  // using it keep it (see checkCategory and the delivery zones).
  async function update(req, res, next) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next({ status: 400, message: `Invalid ${lower} id` });
    }

    const result = updateSchema.safeParse(req.body);
    if (!result.success) {
      return next({ status: 400, message: result.error.issues[0].message });
    }

    const item = await Model.findById(req.params.id);
    if (!item) {
      return next({ status: 404, message: `${label} not found` });
    }

    Object.assign(item, result.data);
    await item.save();
    res.json({ [itemKey]: item });
  }

  return { list, create, update };
}

// How many products are in each category (hidden products too).
async function productsPerCategory(ids) {
  const rows = await Product.aggregate([
    { $match: { category: { $in: ids } } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

// How many shops deliver to each area. A shop keeps its zones in an array, so
// $unwind first splits each shop into one document per zone (as with order
// lines in the seller's numbers), then we count per area.
async function shopsPerArea(ids) {
  const rows = await Shop.aggregate([
    { $unwind: "$deliveryZones" },
    { $match: { "deliveryZones.area": { $in: ids } } },
    { $group: { _id: "$deliveryZones.area", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

const categories = lookupHandlers({
  Model: Category,
  label: "Category",
  listKey: "categories",
  itemKey: "category",
  extraFields: {
    icon: z.string().trim().max(50, "Icon is too long (max 50 characters)").optional(),
  },
  countKey: "productCount",
  countUsage: productsPerCategory,
});

const areas = lookupHandlers({
  Model: Area,
  label: "Area",
  listKey: "areas",
  itemKey: "area",
  countKey: "shopCount",
  countUsage: shopsPerArea,
});

module.exports = { categories, areas };
