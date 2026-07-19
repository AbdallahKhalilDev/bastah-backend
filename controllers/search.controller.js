const {
  DROPDOWN_LIMIT,
  searchProducts,
  searchShops,
  searchCategories,
} = require("../utils/searchQueries");

// GET /api/search
// Public, read-only. The "search everything" box.
//
// This is the BUNDLE for the type-ahead dropdown: a small capped list of matching
// PRODUCTS, SHOPS, and CATEGORIES, plus `counts` (the grand total of matches per
// group) so the UI can show "See all 42 products". Slice 4 adds the paginated
// ?type= "see all" mode.
//
// An empty/whitespace q is NOT an error — there's simply nothing to show yet, so
// each group comes back empty with a zero count (the helpers handle this).
async function search(req, res, next) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  // Run the three searches in parallel — they don't depend on each other — the
  // same way GET /api/home fans out its three Home-page queries.
  const [products, shops, categories] = await Promise.all([
    searchProducts({ q, limit: DROPDOWN_LIMIT }),
    searchShops({ q, limit: DROPDOWN_LIMIT }),
    searchCategories({ q, limit: DROPDOWN_LIMIT }),
  ]);

  res.json({
    query: q,
    products: products.items,
    shops: shops.items,
    categories: categories.items,
    // Grand total per group, so a frontend can render "See all N".
    counts: {
      products: products.total,
      shops: shops.total,
      categories: categories.total,
    },
  });
}

module.exports = { search };
