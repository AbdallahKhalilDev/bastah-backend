// OFFERS: a shop telling its customers about a deal.
//
//   Sellers (under /api/seller, already checked once by that router):
//     POST  /api/seller/offers        post an offer for one of MY open shops
//     GET   /api/seller/offers        my shops' offers, current and old
//     PATCH /api/seller/offers/:id    edit an offer I posted
//   Admins (under /api/admin, the same three functions):
//     POST  /api/admin/offers         post for ANY open shop, no daily limit
//     GET   /api/admin/offers         every offer
//     PATCH /api/admin/offers/:id     edit any offer (e.g. switch one off)
//   Everyone (no login):
//     GET   /api/offers               every current offer
//     GET   /api/shops/:shopId/offers one open shop's current offers
//
// Each dashboard function is mounted on BOTH routers, like the item list
// (listDashboardListings). The router has already checked the role; the few
// differences between a seller and an admin are inside each function.
const mongoose = require("mongoose");
const { z } = require("zod");
const Offer = require("../models/Offer");
const Shop = require("../models/Shop");
const Product = require("../models/Product");
const Listing = require("../models/Listing");
const parsePagination = require("../utils/pagination");
const { shopFilter } = require("../utils/sellerQueries");
const { startOfGazaDay } = require("../utils/gazaTime");
const { PUBLIC_SHOP_FIELDS } = require("../utils/homeQueries");
const { VISIBLE_PRODUCT } = require("../utils/productRules");
const { notifyOfferPosted } = require("../utils/offerNotifications");

// How many offers a SELLER may post per shop per day (a Gaza calendar day,
// midnight to midnight). Each offer notifies the shop's customers, so this stops
// a seller from flooding them. Admins have no limit.
const SELLER_OFFERS_PER_DAY = 1;

// --- Input validation ---------------------------------------------------------

// The end date arrives as TEXT (JSON has no date type), e.g.
// "2026-12-31T20:00:00Z" or just "2026-12-31". Step by step:
//   1. it must be text at all (missing → "End date is required");
//   2. the text must be a real date (Date.parse gives NaN for "banana");
//   3. turn it into a real Date;
//   4. it must still be in the future (an offer that has already ended is useless).
const endsAtRule = z
  .string({ error: "End date is required" })
  .refine((s) => !Number.isNaN(Date.parse(s)), "End date must be a valid date")
  .transform((s) => new Date(s))
  .refine((d) => d > new Date(), "End date must be in the future");

// The text, in both languages, with the same limits as announcements.
const textFields = {
  title: z
    .string({ error: "Title is required" })
    .trim()
    .min(1, "Title is required")
    .max(100, "Title is too long (max 100 characters)"),
  titleAr: z
    .string({ error: "Arabic title is required" })
    .trim()
    .min(1, "Arabic title is required")
    .max(100, "Arabic title is too long (max 100 characters)"),
  body: z
    .string({ error: "Message is required" })
    .trim()
    .min(1, "Message is required")
    .max(1000, "Message is too long (max 1000 characters)"),
  bodyAr: z
    .string({ error: "Arabic message is required" })
    .trim()
    .min(1, "Arabic message is required")
    .max(1000, "Arabic message is too long (max 1000 characters)"),
};

// Posting: everything is required except the product. A WHITELIST, as always:
// `createdBy` and `isActive` aren't here, so a client can't set them.
const createOfferSchema = z.object({
  shop: z.string({ error: "Shop is required" }).min(1, "Shop is required"),
  product: z.string().optional(),
  ...textFields,
  endsAt: endsAtRule,
});

// Editing: every field optional (a PATCH changes only what you send). Notice
// what's NOT here: `shop` and `product`. An offer can't be moved to another shop
// or product, for the same reason a listing can't: its notifications already
// went out saying what it's about. To change that, post a new offer.
const updateOfferSchema = z.object({
  title: textFields.title.optional(),
  titleAr: textFields.titleAr.optional(),
  body: textFields.body.optional(),
  bodyAr: textFields.bodyAr.optional(),
  endsAt: endsAtRule.optional(),
  isActive: z.boolean({ error: "isActive must be true or false" }).optional(),
});

// --- Shared helpers -----------------------------------------------------------

// "Current" = switched on AND not ended yet. A function, not a constant, so
// "now" is the moment of each request, not the moment the server started.
function currentOffers() {
  return { isActive: true, endsAt: { $gt: new Date() } };
}

// What the DASHBOARDS see: the shop's name (and whether it's open), the product,
// and who posted it (name and role, so it's clear whether a seller or an admin did).
function populateForDashboard(query) {
  return query
    .populate("shop", "name isActive")
    .populate("product", "name nameAr imageUrl unit isActive")
    .populate("createdBy", "name role");
}

// What CUSTOMERS see: the shop's public fields and the product. Never who posted
// it. A product an admin has hidden since comes back as null (the populate
// `match`), and the offer stays up as an offer for the whole shop.
function populateForPublic(query) {
  return query
    .select("-createdBy")
    .populate("shop", PUBLIC_SHOP_FIELDS)
    .populate({
      path: "product",
      select: "name nameAr imageUrl unit",
      match: VISIBLE_PRODUCT,
    });
}

// One page of offers + the total, newest first (_id breaks ties, as in the inbox).
async function findPage(filter, populate, { skip, limit }) {
  return Promise.all([
    populate(Offer.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)),
    Offer.countDocuments(filter),
  ]);
}

// --- Dashboards ---------------------------------------------------------------

// POST /api/seller/offers  and  POST /api/admin/offers
// Replies 201 { offer, notified }: `notified` is how many customers were told.
async function createOffer(req, res, next) {
  const isAdmin = req.user.role === "admin";

  // 1. Validate the body.
  const result = createOfferSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }
  const data = result.data;

  // 2. The shop. Its id came in the BODY, so a bad or unknown one is a 400
  //    (the same rule as a category id when creating a product).
  if (!mongoose.Types.ObjectId.isValid(data.shop)) {
    return next({ status: 400, message: "Invalid shop id" });
  }
  const shop = await Shop.findById(data.shop);
  if (!shop) {
    return next({ status: 400, message: "Shop not found" });
  }

  // 3. A seller posts only for their OWN shops.
  if (!isAdmin && shop.owner.toString() !== req.user.id) {
    return next({ status: 403, message: "Forbidden" });
  }

  // 4. Only an OPEN shop can post: customers can't even see a closed one.
  //    A seller whose shop an admin LOCKED gets 403 with the Step 17 code
  //    "shop_locked" and the admin's reason, exactly like when they try to
  //    re-open it. Everything else closed is a 409 (a state problem: open the
  //    shop first).
  if (!shop.isActive) {
    if (shop.lock && !isAdmin) {
      return next({
        status: 403,
        code: "shop_locked",
        message: `This shop was closed by an admin: ${shop.lock.reason}`,
      });
    }
    return next({ status: 409, message: `${shop.name} is closed, so it can't post offers` });
  }

  // 5. The product, if one was given: it must exist, be visible to customers,
  //    and be sold by THIS shop.
  let productId = null;
  if (data.product) {
    if (!mongoose.Types.ObjectId.isValid(data.product)) {
      return next({ status: 400, message: "Invalid product id" });
    }
    const product = await Product.findOne({ _id: data.product, ...VISIBLE_PRODUCT }).select("_id");
    if (!product) {
      return next({ status: 400, message: "Product not found" });
    }
    const sells = await Listing.exists({ shop: shop._id, product: product._id });
    if (!sells) {
      return next({ status: 400, message: "This shop does not sell that product" });
    }
    productId = product._id;
  }

  // 6. The seller's daily limit: how many offers have I posted for this shop
  //    since midnight (Gaza time)? Switched-off offers still count, so posting,
  //    switching off and posting again can't get around it. Admin offers don't
  //    count (they're not createdBy this seller), and admins have no limit.
  //
  //    429 = "Too Many Requests": the request was fine, there have just been too
  //    many of them in this time window. The code lets the app show its own
  //    (Arabic) message.
  if (!isAdmin) {
    const postedToday = await Offer.countDocuments({
      shop: shop._id,
      createdBy: req.user.id,
      createdAt: { $gte: startOfGazaDay(0) },
    });
    if (postedToday >= SELLER_OFFERS_PER_DAY) {
      return next({
        status: 429,
        code: "offer_limit_reached",
        message: "This shop has already posted an offer today (one per shop per day)",
      });
    }
  }

  // 7. Save it. createdBy comes from the token, never the body.
  const offer = await Offer.create({
    shop: shop._id,
    product: productId,
    title: data.title,
    titleAr: data.titleAr,
    body: data.body,
    bodyAr: data.bodyAr,
    endsAt: data.endsAt,
    createdBy: req.user.id,
  });

  // 8. Tell the shop's customers. Never throws: the offer is posted either way.
  const notified = await notifyOfferPosted(offer, shop, req.user.id);

  const populated = await populateForDashboard(Offer.findById(offer._id));
  res.status(201).json({ offer: populated, notified });
}

// PATCH /api/seller/offers/:id  and  PATCH /api/admin/offers/:id
// Edit the text, the end date, or switch it off/on. NEVER re-sends
// notifications: customers were told once, when it was posted; otherwise every
// small edit would ping them again.
async function updateOffer(req, res, next) {
  const isAdmin = req.user.role === "admin";

  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid offer id" });
  }
  const offer = await Offer.findById(req.params.id);
  if (!offer) {
    return next({ status: 404, message: "Offer not found" });
  }

  // A seller edits only offers they posted themselves. An offer an admin posted
  // on their shop is the admin's to change.
  if (!isAdmin && offer.createdBy.toString() !== req.user.id) {
    return next({ status: 403, message: "You can only edit offers you posted" });
  }

  const result = updateOfferSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }
  const data = result.data;

  // A seller may switch their offer OFF, but not back ON: if an admin switched
  // it off (a misleading offer, say), the seller mustn't be able to undo that.
  // A seller who wants it back posts a new one (the daily limit applies).
  if (!isAdmin && data.isActive === true && !offer.isActive) {
    return next({ status: 403, message: "Only an admin can switch an offer back on" });
  }

  Object.assign(offer, data);
  await offer.save();

  const populated = await populateForDashboard(Offer.findById(offer._id));
  res.json({ offer: populated });
}

// GET /api/seller/offers  and  GET /api/admin/offers
// Current AND old offers (switched off, ended), newest first, paginated.
// A seller sees the offers of all their shops, including ones an admin posted
// there; ?shop= narrows it to one shop (someone else's → 403). An admin sees
// every offer, or one shop's with ?shop=. shopFilter() is the same helper the
// order inbox and the item list use.
async function listDashboardOffers(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);

  const { problem, filter } = await shopFilter(req.user, req.query.shop);
  if (problem) {
    return next(problem);
  }

  const [offers, total] = await findPage(filter, populateForDashboard, { skip, limit });
  res.json({ offers, page, limit, total });
}

// --- Public -------------------------------------------------------------------

// GET /api/offers
// Every CURRENT offer (switched on, not ended) from an OPEN shop, newest first,
// paginated. For an "offers" page or a strip on the home screen.
async function listCurrentOffers(req, res) {
  const { page, limit, skip } = parsePagination(req.query);

  // Closed and locked shops' offers are hidden. Same two-step idea as the seller
  // inbox in Step 12: first the ids of the open shops (distinct gives each once),
  // then "offers whose shop is one of those".
  const openShopIds = await Shop.distinct("_id", { isActive: true });
  const filter = { ...currentOffers(), shop: { $in: openShopIds } };

  const [offers, total] = await findPage(filter, populateForPublic, { skip, limit });
  res.json({ offers, page, limit, total });
}

// GET /api/shops/:shopId/offers
// One shop's CURRENT offers, for its page. A closed shop is hidden, like its
// page: 404.
async function listShopOffers(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.shopId)) {
    return next({ status: 400, message: "Invalid shop id" });
  }
  const shop = await Shop.findById(req.params.shopId).select("isActive");
  if (!shop || !shop.isActive) {
    return next({ status: 404, message: "Shop not found" });
  }

  const { page, limit, skip } = parsePagination(req.query);
  const filter = { ...currentOffers(), shop: shop._id };

  const [offers, total] = await findPage(filter, populateForPublic, { skip, limit });
  res.json({ offers, page, limit, total });
}

module.exports = {
  createOffer,
  updateOffer,
  listDashboardOffers,
  listCurrentOffers,
  listShopOffers,
};
