const Cart = require("../models/Cart");

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

module.exports = {
  getPopulatedCart,
  getCart,
};
