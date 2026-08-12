const mongoose = require("mongoose");
const { z } = require("zod");
const Shop = require("../models/Shop");
const Category = require("../models/Category");
const Area = require("../models/Area");
const homeQueries = require("../utils/homeQueries");

// The ONE description of how delivery zones are populated for a read, so the
// endpoints that expose them can't drift apart.
const ZONE_POPULATE = { path: "deliveryZones.area", select: "name nameAr slug" };

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

// The "update shop" body uses the SAME whitelist as create, but EVERY field is
// optional — a PATCH changes only the fields you send and leaves the rest alone.
// name/phone are still min(1) *when present*, so you can't blank them out. As
// with create, unknown keys (owner, isVerified, ratingAvg, ratingCount) are
// stripped, so this endpoint can never change the system-controlled fields.
const updateShopSchema = z.object({
  name: z.string().min(1, "Name cannot be empty").optional(),
  phone: z.string().min(1, "Phone cannot be empty").optional(),
  area: z.string().optional(),
  address: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().optional(),
  category: z.string().optional(),
  isActive: z.boolean().optional(),
});

// The whitelist for SETTING a shop's delivery zones. This is the first
// zod-validated ARRAY in the codebase, so a couple of notes:
//
//  - `.max(60)` caps it. A MongoDB document can hold 16MB, but "it fits" is not
//    a design — nobody legitimately delivers to sixty areas, and without a cap a
//    client could post ten thousand zones into one document.
//  - zod reports only the FIRST problem (our house convention everywhere), so a
//    bad zone at index 4 produces a message with no index in it. That's
//    acceptable and consistent; the client is sending a list it built itself.
//  - `fee` is required per zone rather than defaulting, so a seller has to say
//    what they charge. 0 is a perfectly good answer meaning "free delivery".
const setZonesSchema = z.object({
  zones: z
    .array(
      z.object({
        area: z.string().min(1, "Area is required"),
        fee: z.number().min(0, "Fee cannot be negative"),
      })
    )
    .max(60, "Too many delivery zones"),
});

// GET /api/shops
// Public. Returns every ACTIVE shop, sorted by name.
async function listShops(req, res, next) {
  // find({ isActive: true }) hides any shop we've deactivated. When there are no
  // shops yet this simply returns [] — an empty list is a correct, successful
  // answer (status 200), not an error.
  const filter = { isActive: true };

  // Optional ?deliversTo=<areaId> — "only shops that deliver to my area".
  //
  // The dot notation reaches INSIDE the embedded array: it means "any shop with
  // at least one zone whose area is this one". That's served by the multikey
  // index on Shop, so it stays a lookup rather than a scan.
  //
  // We guard the id first, exactly like ?category= does in the product search:
  // an id-shaped query param that's malformed would make MongoDB throw, and a
  // clean 400 is far more useful than a 500.
  if (req.query.deliversTo) {
    if (!mongoose.Types.ObjectId.isValid(req.query.deliversTo)) {
      return next({ status: 400, message: "Invalid area id" });
    }
    filter["deliveryZones.area"] = req.query.deliversTo;
  }

  // .populate() swaps a stored reference id for the real document it points at:
  //   - "category" → the full Category (so the client sees its name, not an id)
  //   - "owner", "name" → the owner User, but ONLY their `name` field. This is a
  //     PUBLIC endpoint, so we must never leak the owner's email or passwordHash.
  //     The second argument is a "projection" — the whitelist of fields to send.
  //   - the delivery zones' areas, so a "delivers to your area for ₪5" line can
  //     be drawn without a second request.
  const shops = await Shop.find(filter)
    .sort({ name: 1 })
    .populate("category")
    .populate("owner", "name")
    .populate(ZONE_POPULATE);

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
    .populate("owner", "name")
    .populate(ZONE_POPULATE);

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

// PATCH /api/shops/:id
// Protected: a logged-in seller or admin (auth + requireRole run first). A
// seller may edit ONLY their own shop; an admin may edit ANY shop.
async function updateShop(req, res, next) {
  // 1. Guard the id (else findById would throw a CastError on junk like "abc").
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Load the shop. A well-formed id that matches nothing is a 404.
  //    (Unlike the public reads, we do NOT hide inactive shops here — an owner
  //    must be able to find and re-activate a shop they've deactivated.)
  const shop = await Shop.findById(req.params.id);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Ownership check. Admins skip it. For a seller, the shop's owner id must
  //    equal their own id (owner is an ObjectId, so .toString() to compare it
  //    to the string id from the token). If not, 403 — they're logged in, but
  //    it isn't their shop.
  if (
    req.user.role !== "admin" &&
    shop.owner.toString() !== req.user.id
  ) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body against the update whitelist.
  const result = updateShopSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. If they're changing the category, verify the new one exists (same check
  //    as create). Omitting category leaves the current one untouched.
  if (data.category) {
    if (!mongoose.Types.ObjectId.isValid(data.category)) {
      return next({ status: 400, message: "Invalid category id" });
    }
    const category = await Category.findById(data.category);
    if (!category) {
      return next({ status: 400, message: "Category not found" });
    }
  }

  // 6. Copy the validated fields onto the loaded document, then save. save()
  //    runs the schema's validators and updates the `updatedAt` timestamp.
  //    Because `data` only ever contains whitelisted keys, there's no way for a
  //    forbidden field to slip in here.
  Object.assign(shop, data);
  await shop.save();

  res.json({ shop });
}

// GET /api/shops/top
// Public. The Home page's "top stores" strip: the best-rated ACTIVE shops, capped
// by ?limit (default 10). All the query logic (the two-key sort, the isActive
// filter, and the safe public projection) lives in the shared helper so this
// endpoint and the bundled /api/home can't disagree. We reply with just { shops }
// — a small fixed list, not a paged one.
async function getTopStores(req, res, next) {
  const limit = homeQueries.clampLimit(req.query, 10);
  const shops = await homeQueries.getTopStores({ limit });
  res.json({ shops });
}

// PATCH /api/shops/:shopId/delivery-zones
// Protected: a logged-in seller or admin (auth + requireRole run first). A seller
// may set zones only on their OWN shop; an admin may set them on any shop.
//
// ⚠ THIS REPLACES THE WHOLE LIST — it does not merge. Sending
// `{ "zones": [] }` means "I've stopped delivering". That's the same meaning
// PATCH already has on a cart item ("set this outright"), and it keeps us from
// needing a fifth HTTP verb just for this one endpoint. It's the one genuinely
// surprising thing in this feature, so it's called out in bold in docs/API.md.
//
// Delivery zones live here rather than in updateShopSchema because validating an
// array of objects (each id checked against the Area collection) doesn't belong
// in the general "edit my shop details" endpoint.
async function updateDeliveryZones(req, res, next) {
  // 1. Guard the shop id from the URL.
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }

  // 2. Load the shop. A well-formed id matching nothing is a 404. (Like
  //    updateShop, we do NOT hide inactive shops — an owner must still be able
  //    to configure a shop they've temporarily deactivated.)
  const shop = await Shop.findById(req.params.shopId);
  if (!shop) {
    return next({ status: 404, message: "Shop not found" });
  }

  // 3. Ownership. Admins skip it; a seller must own this shop.
  if (req.user.role !== "admin" && shop.owner.toString() !== req.user.id) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Validate the body shape.
  const result = setZonesSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 5. Check every area id is real, and that no area appears twice.
  //
  //    All of these are 400, not 404: the ids arrived in the BODY, so a bad one
  //    is the caller's mistake — the same rule createShop follows for a
  //    body-supplied category id. (An id in the URL PATH matching nothing is the
  //    404 case, which is step 2 above.)
  //
  //    The duplicate check is a per-document rule, which is why it lives here
  //    and not in a unique index: two different SHOPS may both deliver to Rimal,
  //    but one shop must not list Rimal twice with two different fees.
  const seen = new Set();
  for (const zone of data.zones) {
    if (!mongoose.Types.ObjectId.isValid(zone.area)) {
      return next({ status: 400, message: "Invalid area id" });
    }
    if (seen.has(zone.area)) {
      return next({ status: 400, message: "Duplicate delivery zone" });
    }
    seen.add(zone.area);

    const area = await Area.findById(zone.area);
    if (!area) {
      return next({ status: 400, message: "Area not found" });
    }
  }

  // 6. Replace the list outright and save.
  shop.deliveryZones = data.zones;
  await shop.save();

  // 7. Return the shop with the zones' areas populated, so the client can render
  //    "Rimal — ₪5" without a second request.
  const populated = await Shop.findById(shop._id)
    .populate("category")
    .populate("owner", "name")
    .populate(ZONE_POPULATE);

  res.json({ shop: populated });
}

module.exports = {
  listShops,
  getShop,
  createShop,
  updateShop,
  getTopStores,
  updateDeliveryZones,
};
