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

// A WHITELIST for SETTING an item's quantity (PATCH). Here `quantity` is REQUIRED
// (a PATCH with nothing to set is pointless) and, unlike POST's optional add, it
// replaces the value outright. The listing being changed comes from the URL, not
// the body — so it's not in this schema.
const setQuantitySchema = z.object({
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1"),
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

// A note on the route param for the next three handlers -------------------
// PATCH and DELETE address an item by the LISTING id in the URL
// (/api/cart/items/:listingId), NOT by a separate cart-item id. Why: cart items
// are embedded subdocuments we created with `_id: false`, so they have no id of
// their own — and a given listing appears at most ONCE in a cart, so the listing
// id already identifies the line uniquely. The client also naturally knows the
// listing id (it's what it added), so there's nothing extra to look up.

// PATCH /api/cart/items/:listingId
// Protected: a logged-in CUSTOMER only. SETS the quantity of one existing item to
// a given value (contrast POST, which ADDS). If the item isn't in the cart → 404.
async function setItemQuantity(req, res, next) {
  // 1. Guard the listing id from the URL (else the .find comparison below is just
  //    against junk, and it lets us give a clean 400 instead).
  if (!mongoose.Types.ObjectId.isValid(req.params.listingId)) {
    return next({ status: 400, message: "Invalid listing id" });
  }

  // 2. Validate the body → 400. quantity is required here.
  const result = setQuantitySchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 3. Load the caller's own cart. No cart (or the item isn't in it) means there's
  //    nothing to set → 404. You can't change the quantity of a line that isn't
  //    there. (This is the one place a missing item is a 404 — see DELETE below,
  //    which is idempotent instead.)
  const cart = await Cart.findOne({ customer: req.user.id });
  const item = cart
    ? cart.items.find((i) => i.listing.toString() === req.params.listingId)
    : null;
  if (!item) {
    return next({ status: 404, message: "Item not in cart" });
  }

  // 4. Set the new quantity outright and save.
  item.quantity = data.quantity;
  await cart.save();

  // 5. Return the same populated shape as GET.
  const populated = await getPopulatedCart(req.user.id);
  res.json({ cart: populated });
}

// DELETE /api/cart/items/:listingId
// Protected: a logged-in CUSTOMER only. Removes ONE item from the caller's cart.
// Idempotent: removing something that's already gone (or from a customer with no
// cart yet) is still a success (200) — DELETE should be safe to retry. So, unlike
// PATCH, a "not there" item is NOT a 404 here.
async function removeItem(req, res, next) {
  // 1. Same listing-id guard → 400 on a malformed id.
  if (!mongoose.Types.ObjectId.isValid(req.params.listingId)) {
    return next({ status: 400, message: "Invalid listing id" });
  }

  // 2. Load the caller's cart. If they have none yet, there's nothing to remove —
  //    return the empty cart shape (200), same as GET does for a cartless user.
  const cart = await Cart.findOne({ customer: req.user.id });
  if (!cart) {
    return res.json({ cart: { items: [] } });
  }

  // 3. Keep every item EXCEPT the one whose listing matches. If nothing matched,
  //    the array is simply unchanged — that's the idempotent case.
  cart.items = cart.items.filter(
    (i) => i.listing.toString() !== req.params.listingId
  );
  await cart.save();

  // 4. Return the updated, populated cart.
  const populated = await getPopulatedCart(req.user.id);
  res.json({ cart: populated });
}

// DELETE /api/cart
// Protected: a logged-in CUSTOMER only. Empties the WHOLE cart (items → []). Like
// removeItem, this is safe to call even when there's no cart yet.
async function clearCart(req, res, next) {
  const cart = await Cart.findOne({ customer: req.user.id });

  // No cart yet → nothing to empty; return the empty cart shape (200).
  if (!cart) {
    return res.json({ cart: { items: [] } });
  }

  // Drop every line and save. The populated result will simply have items: [].
  cart.items = [];
  await cart.save();

  const populated = await getPopulatedCart(req.user.id);
  res.json({ cart: populated });
}

module.exports = {
  getPopulatedCart,
  getCart,
  addItem,
  setItemQuantity,
  removeItem,
  clearCart,
};
