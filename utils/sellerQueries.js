// The ONE answer to "which shops does this request cover?" for seller dashboard
// reads (and the order inbox, which admins use too).
//
// A seller may own SEVERAL shops (Shop.owner is not unique), so "my orders" or
// "my items" always means: find my shop ids first, then filter by them. That
// two-step query used to live inside the order inbox; it lives here now so the
// inbox, the seller's item list and (later) the seller's numbers all share it.
const mongoose = require("mongoose");
const Shop = require("../models/Shop");

// The ids of every shop this user owns, open or closed. Only the ids: callers
// need something to filter by, not whole shop documents.
async function getMyShopIds(userId) {
  const shops = await Shop.find({ owner: userId }).select("_id");
  return shops.map((s) => s._id);
}

// Turns the caller + an optional ?shop=<id> into a filter on a `shop` field.
// Orders and listings both store their shop in a field called `shop`, so the
// same filter works on both collections.
//
// Returns { problem } (pass it to next()) or { filter }:
//
//   who      ?shop=        filter
//   admin    (none)        {}                          every shop
//   admin    any shop id   { shop: id }                that one shop
//   seller   (none)        { shop: { $in: myIds } }    all of MY shops
//   seller   one of mine   { shop: id }                that one shop
//   seller   not mine      403                         someone else's shop
//
// A seller asking for someone else's shop gets 403, the same answer as editing
// someone else's listing. A seller with NO shops gets `$in: []`, which matches
// nothing: an empty page, already the right answer, so no special case.
async function shopFilter(user, shopParam) {
  // An empty ?shop= counts as "not given", like ?status= elsewhere.
  if (shopParam && !mongoose.Types.ObjectId.isValid(shopParam)) {
    // isValid also rejects ?shop=a&shop=b, which Express hands us as an array.
    return { problem: { status: 400, message: "Invalid shop id" } };
  }

  if (user.role === "admin") {
    return { filter: shopParam ? { shop: shopParam } : {} };
  }

  const myShopIds = await getMyShopIds(user.id);
  if (!shopParam) {
    return { filter: { shop: { $in: myShopIds } } };
  }

  // The ids are ObjectIds and shopParam is a string, so compare as strings.
  const isMine = myShopIds.some((id) => id.toString() === shopParam);
  if (!isMine) {
    return { problem: { status: 403, message: "Forbidden" } };
  }
  return { filter: { shop: shopParam } };
}

module.exports = { getMyShopIds, shopFilter };
