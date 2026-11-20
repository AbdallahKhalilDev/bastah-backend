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

// --- Old prices -----------------------------------------------------------
// ?staleDays= on the seller's item list must be a whole number in this range.
const MIN_STALE_DAYS = 1;
const MAX_STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// The ONE rule for "this price may be out of date": the seller hasn't confirmed
// it in the last `days` days, OR has never confirmed it at all.
//
// "3 days" here means 72 hours back from right now, not "since midnight three
// days ago". For "is this price old?", a plain count of hours is enough.
//
// `priceConfirmedAt: null` matches BOTH a stored null AND a field that isn't
// stored at all (listings made before this field existed). That's the same lesson
// as `?status=active` matching old users in Step 16.
function staleFilter(days) {
  const cutoff = new Date(Date.now() - days * DAY_MS);
  return {
    $or: [{ priceConfirmedAt: null }, { priceConfirmedAt: { $lt: cutoff } }],
  };
}

module.exports = {
  getMyShopIds,
  shopFilter,
  staleFilter,
  MIN_STALE_DAYS,
  MAX_STALE_DAYS,
};
