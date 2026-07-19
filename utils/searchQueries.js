// Shared query helpers for GLOBAL SEARCH (the "search everything" box).
//
// Why this file exists — the same reason as utils/homeQueries.js: the global
// search is exposed TWO ways at once — bundled (a few of each type, for the
// type-ahead dropdown) AND per-type + paginated (the "see all" results page).
// If each place wrote its own query they could drift apart. So the ONE canonical
// search for each model lives here as a small function, and every endpoint calls
// these. They can never disagree about which fields match or how results sort.
//
// Each function returns { items, total }, so the SAME function serves both modes:
// the bundle asks for a small `limit` at `skip` 0, the "see all" page asks for a
// full page (skip/limit). `total` is the grand count of matches, which the
// dropdown uses to show "See all 42 products".
//
// Matching is REGEX-based (case-insensitive partial match), exactly like the
// existing product search. We deliberately keep that over a MongoDB text index:
// regex matches substrings as the user types, while a text index only matches
// whole words. A text index is a future scaling optimization, not part of this.
//
// Built in slices: this file starts with PRODUCTS (Slice 1); searchShops and
// searchCategories are added in Slices 2 and 3.

const Product = require("../models/Product");
const escapeRegex = require("./escapeRegex");

// How many of each group the bundled dropdown returns. Small on purpose — the
// dropdown shows a taste of each type, with a "See all N" link for the rest.
const DROPDOWN_LIMIT = 5;

// Turn a raw query string into a case-insensitive partial-match regex, or null
// when the query is empty/whitespace (nothing to search for yet).
function toRegex(q) {
  const trimmed = typeof q === "string" ? q.trim() : "";
  return trimmed ? new RegExp(escapeRegex(trimmed), "i") : null;
}

// Products — bilingual: match the English name OR the Arabic nameAr, the same
// fields the existing /api/products/search matches. Sorted A→Z for a predictable
// type-ahead. Category populated down to name/nameAr only, like every other
// product read.
async function searchProducts({ q, limit, skip = 0 }) {
  const rx = toRegex(q);
  if (!rx) return { items: [], total: 0 };

  const filter = { $or: [{ name: rx }, { nameAr: rx }] };
  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .populate("category", "name nameAr"),
    Product.countDocuments(filter),
  ]);
  return { items, total };
}

module.exports = {
  DROPDOWN_LIMIT,
  searchProducts,
};
