// The admin dashboard's PRODUCT screens: the whole catalog (hidden products
// too) and the hide / show switch.
//
// Every route here is admin-only. That's enforced ONCE, in
// routes/admin.routes.js (router.use), so these functions don't repeat it.
//
// Editing a product's name, category… is the shared PATCH /api/products/:id
// (an admin may always edit there), and featuring is PATCH /api/products/:id/feature.
const mongoose = require("mongoose");
const { z } = require("zod");
const Product = require("../models/Product");
const Listing = require("../models/Listing");
const parsePagination = require("../utils/pagination");
const parseBooleanQuery = require("../utils/booleanQuery");
const escapeRegex = require("../utils/escapeRegex");
const { VISIBLE_PRODUCT } = require("../utils/productRules");

// An explicit set, like featuring or verifying: { "isActive": false } hides,
// { "isActive": true } shows again. Sending the current value twice is fine.
const setActiveSchema = z.object({
  isActive: z.boolean({ error: "isActive must be true or false" }),
});

// The ONE way an admin reply fills in a product's links: its category, and who
// created it (name, email and role, so the admin can tell a seller from an
// admin). "+createdBy" asks for the field the schema hides from public reads.
function populateForAdmin(query) {
  return query
    .select("+createdBy")
    .populate("category", "name nameAr")
    .populate("createdBy", "name email role");
}

// How many shops sell each of these products: one listing per shop per product
// (the unique index), so counting listings counts shops. One aggregation for the
// whole page, the same $group-by-a-field idea as the order status counts.
// Returns a Map: product id string → count. A product nobody sells isn't in it.
async function shopCounts(productIds) {
  const rows = await Listing.aggregate([
    { $match: { product: { $in: productIds } } },
    { $group: { _id: "$product", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id.toString(), row.count]));
}

// GET /api/admin/products
// The WHOLE catalog, hidden products too, newest first, paginated. Each product
// comes with who created it and `shopCount` (how many shops sell it; 0 = nobody,
// a likely candidate to tidy up).
// Optional filters (they combine):
//   ?q=text                 name or Arabic name contains this text
//   ?category=<id>          one category
//   ?isActive=true|false    shown / hidden products
//   ?createdBy=<userId>     products one person added
async function listAllProducts(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  const isActive = parseBooleanQuery(req.query.isActive, "isActive");
  if (isActive.problem) return next(isActive.problem);
  if (isActive.value === true) Object.assign(filter, VISIBLE_PRODUCT); // incl. old ones with nothing stored
  if (isActive.value === false) filter.isActive = false;

  if (req.query.category) {
    if (!mongoose.Types.ObjectId.isValid(req.query.category)) {
      return next({ status: 400, message: "Invalid category id" });
    }
    filter.category = req.query.category;
  }

  if (req.query.createdBy) {
    if (!mongoose.Types.ObjectId.isValid(req.query.createdBy)) {
      return next({ status: 400, message: "Invalid user id" });
    }
    filter.createdBy = req.query.createdBy;
  }

  const q = String(req.query.q || "").trim();
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: pattern }, { nameAr: pattern }];
  }

  const [products, total] = await Promise.all([
    populateForAdmin(
      Product.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)
    ),
    Product.countDocuments(filter),
  ]);

  const counts = await shopCounts(products.map((p) => p._id));

  res.json({
    products: products.map((p) => ({
      ...p.toObject(),
      shopCount: counts.get(p._id.toString()) || 0,
    })),
    page,
    limit,
    total,
  });
}

// PATCH /api/admin/products/:id/active   body: { "isActive": false | true }
// Hide a product from customers, or show it again. Never a delete: listings,
// carts and old orders point at it.
// While hidden, it's gone from every customer page (browse, search, home,
// product page, price comparison, shop pages), shops can't list it again, and
// checkout refuses it. Old orders keep showing it (they froze its name).
async function setProductActive(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid product id" });
  }

  const result = setActiveSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }

  const product = await Product.findById(req.params.id);
  if (!product) {
    return next({ status: 404, message: "Product not found" });
  }

  product.isActive = result.data.isActive;
  await product.save();

  const populated = await populateForAdmin(Product.findById(product._id));
  res.json({ product: populated });
}

module.exports = { listAllProducts, setProductActive };
