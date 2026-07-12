const mongoose = require("mongoose");
const { z } = require("zod");
const Shop = require("../models/Shop");
const Category = require("../models/Category");

// --- Input validation ---------------------------------------------------
// zod describes exactly what a valid "create shop" body looks like. It is a
// WHITELIST: only these keys are accepted. By default zod *strips* any other key
// it doesn't know about, so if a client sneaks in owner / isVerified / ratingAvg
// / ratingCount, those are silently dropped and can never reach the database.
// That's how we keep the system-controlled fields safe. `owner` is set from the
// login token, not the body (see createShop below).
const createShopSchema = z.object({
  name: z.string().min(1, "Name is required"),
  phone: z.string().min(1, "Phone is required"),
  area: z.string().optional(),
  address: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/shops
// Public. Returns every ACTIVE shop, sorted by name.
async function listShops(req, res, next) {
  // find({ isActive: true }) hides any shop we've deactivated. When there are no
  // shops yet this simply returns [] — an empty list is a correct, successful
  // answer (status 200), not an error.
  //
  // .populate() swaps a stored reference id for the real document it points at:
  //   - "category" → the full Category (so the client sees its name, not an id)
  //   - "owner", "name" → the owner User, but ONLY their `name` field. This is a
  //     PUBLIC endpoint, so we must never leak the owner's email or passwordHash.
  //     The second argument is a "projection" — the whitelist of fields to send.
  const shops = await Shop.find({ isActive: true })
    .sort({ name: 1 })
    .populate("category")
    .populate("owner", "name");

  res.json({ shops });
}

// GET /api/shops/:id
// Public. Returns a single ACTIVE shop by its MongoDB id.
async function getShop(req, res, next) {
  // 1. Guard the id FIRST. `:id` comes straight from the URL, so it could be
  //    anything ("abc", "123"...). If it isn't a valid ObjectId, Mongoose's
  //    findById would throw a CastError. We'd rather tell the caller clearly
  //    that the id is malformed (400).
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Look it up, populating the same public fields as the list above.
  const shop = await Shop.findById(req.params.id)
    .populate("category")
    .populate("owner", "name");

  // 3. Treat "not found" and "hidden" the same way: a 404. A deactivated shop
  //    (isActive === false) must not be reachable by direct link either, so we
  //    don't reveal it exists. (Sellers/admins still edit it by id via PATCH.)
  if (!shop || !shop.isActive) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 4. Success: send the single shop back, wrapped in a named key.
  res.json({ shop });
}

// POST /api/shops
// Protected: only a logged-in seller or admin reaches here (auth + requireRole
// run first, in the route). Creates a shop owned by the caller.
async function createShop(req, res, next) {
  // 1. Validate the body against the whitelist. safeParse doesn't throw — it
  //    returns success/error so we can craft our own readable 400.
  const result = createShopSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. If a category was provided, make sure it's real. First check the id is
  //    well-formed (else Mongoose would throw a CastError), then that a Category
  //    with that id actually exists. Both problems are the caller's bad input,
  //    so both are a 400. When category is omitted we skip this entirely.
  if (data.category) {
    if (!mongoose.Types.ObjectId.isValid(data.category)) {
      return next({ status: 400, message: "Invalid category id" });
    }
    const category = await Category.findById(data.category);
    if (!category) {
      return next({ status: 400, message: "Category not found" });
    }
  }

  // 3. Create the shop. CRITICAL: owner comes from the verified token
  //    (req.user.id set by the `auth` middleware), never from the body — a
  //    client must not be able to create a shop "owned" by someone else.
  const shop = await Shop.create({ ...data, owner: req.user.id });

  // 4. Respond 201 (Created). owner/category appear here as raw ids; the read
  //    endpoints (Slice 2) are where we .populate() them into full documents.
  res.status(201).json({ shop });
}

module.exports = { listShops, getShop, createShop };
