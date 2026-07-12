const mongoose = require("mongoose");
const { z } = require("zod");
const Cart = require("../models/Cart");
const Listing = require("../models/Listing");

// --- Input validation ---------------------------------------------------
// A WHITELIST for adding an item. Only these two keys are accepted; zod strips
// anything else — notice the customer is NOT here (it comes from the login token,
// never the body). `listing` is the id of the listing to add; `quantity` is
// optional and, when omitted, falls back to 1 in the controller.
const addItemSchema = z.object({
  listing: z.string().min(1, "Listing is required"),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .optional(),
});

// --- The shared populate helper -----------------------------------------
// getPopulatedCart loads ONE customer's cart and swaps every stored id for the
// live data the frontend needs to draw the cart. It is the ONE place that
// describes the cart's read shape, so every endpoint (GET now, and POST/PATCH/
// DELETE later) returns EXACTLY the same populated structure — there's no second,
// subtly-different copy of the populate to drift out of sync. (Same "funnel
// everything through one helper" idea as recalcShopRating in review.controller.)
//
// A "populate" tells Mongoose: this field only stores an id; go fetch the real
// document it points at and attach it. We populate on READ (not on save) so the
// customer always sees the CURRENT price — a cart reflects live prices, never a
// snapshot.
//
// This is a NESTED populate: for each item we pull in its `listing` (with the
// live price + inStock), and THROUGH the listing we pull in the `product`
// (name/nameAr/imageUrl/unit) and the `shop`. The shop `select` is a WHITELIST of
// safe public fields (name, area, phone) — the owner and any credentials are
// never even loaded, so they can't leak. Returns the cart document, or null if
// this customer has no cart yet.
function getPopulatedCart(customerId) {
  return Cart.findOne({ customer: customerId }).populate({
    path: "items.listing",
    select: "price inStock shop product",
    populate: [
      { path: "product", select: "name nameAr imageUrl unit" },
      { path: "shop", select: "name area phone" },
    ],
  });
}

// GET /api/cart
// Protected: a logged-in CUSTOMER only (auth + requireRole("customer") run first,
// in the route). Returns THIS caller's cart — always resolved from the verified
// token (req.user.id), never from anything the client sends.
async function getCart(req, res, next) {
  // Load the caller's own cart, fully populated.
  const cart = await getPopulatedCart(req.user.id);

  // A brand-new customer simply hasn't got a cart document yet. That's NOT an
  // error — an empty cart is a perfectly valid answer — so we return a 200 with
  // an empty cart shape rather than a 404. (Slice 3 will create the real cart the
  // first time they add something.)
  if (!cart) {
    return res.json({ cart: { items: [] } });
  }

  res.json({ cart });
}

// POST /api/cart/items
// Protected: a logged-in CUSTOMER only. Adds a listing to the caller's cart. If
// the listing is already in the cart, we ADD to its quantity (see the "already in
// cart" note below); otherwise we push a new line. Creates the cart on first use.
async function addItem(req, res, next) {
  // 1. Validate the body against the whitelist FIRST. Bad shape → 400.
  const result = addItemSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. The listing id came in the BODY (caller-supplied data), so we treat a bad
  //    one as the CALLER's mistake → 400, exactly like createListing does with a
  //    body-supplied product id. (Compare: an id in the URL PATH that matches
  //    nothing is a 404 — the route points at nothing.) A malformed id would make
  //    findById throw a CastError, so we guard it before touching the database.
  if (!mongoose.Types.ObjectId.isValid(data.listing)) {
    return next({ status: 400, message: "Invalid listing id" });
  }
  const listing = await Listing.findById(data.listing);
  if (!listing) {
    return next({ status: 400, message: "Listing not found" });
  }

  // 3. Get-or-create the caller's cart. A brand-new customer has no cart yet, so
  //    the first time they add something we create it (resolved from the token,
  //    never from the client).
  let cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) {
    cart = await Cart.create({ customer: req.user.id, items: [] });
  }

  // 4. Is this listing ALREADY in the cart? We detect it by matching on the
  //    item's `listing` id (each stored as an ObjectId, so .toString() to compare
  //    it to the string id from the body). A listing appears at most once per
  //    cart, so at most one item can match.
  const qtyToAdd = data.quantity ?? 1; // omitted quantity means "one, please"
  const existing = cart.items.find(
    (item) => item.listing.toString() === data.listing
  );
  if (existing) {
    // ADD to the existing quantity (not overwrite). Rationale: pressing "add to
    // cart" a second time means the shopper wants MORE. Setting an exact number
    // is what PATCH is for — so POST adds, PATCH sets. This keeps the two
    // endpoints' jobs clear and non-overlapping.
    existing.quantity += qtyToAdd;
  } else {
    // New listing → push a fresh line.
    cart.items.push({ listing: data.listing, quantity: qtyToAdd });
  }
  await cart.save();

  // 5. Return the SAME populated shape as GET, via the shared helper — so the
  //    client gets the updated cart with every item's live price/product/shop.
  const populated = await getPopulatedCart(req.user.id);
  res.status(201).json({ cart: populated });
}

module.exports = {
  getPopulatedCart,
  getCart,
  addItem,
};
