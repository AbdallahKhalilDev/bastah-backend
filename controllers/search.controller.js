const {
  DROPDOWN_LIMIT,
  searchProducts,
  searchShops,
  searchCategories,
} = require("../utils/searchQueries");
const parsePagination = require("../utils/pagination");

// Maps a ?type value to its canonical search helper. Doubles as the whitelist of
// valid types for the "see all" mode — an unknown type isn't in here, so it 400s.
const TYPES = {
  products: searchProducts,
  shops: searchShops,
  categories: searchCategories,
};

// GET /api/search
// Public, read-only. The "search everything" box. ONE endpoint, TWO modes:
//
//   • No ?type  → BUNDLE (the type-ahead dropdown): a small capped list of matching
//     PRODUCTS, SHOPS, and CATEGORIES at once, plus `counts` (the grand total of
//     matches per group) so the UI can show "See all 42 products".
//
//   • ?type=products|shops|categories → SEE-ALL (one results page): that single
//     type, fully paginated (?page/?limit), in the same { results, page, limit,
//     total } shape the rest of the app's list endpoints use. Unlike the bundle,
//     this is NOT capped at 5 — it's how the "See all" link pages the full set.
//
// An empty/whitespace q is NOT an error — there's simply nothing to show yet, so
// each group comes back empty with a zero count/total (the helpers handle this).
async function search(req, res, next) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const type = req.query.type;

  // --- Mode B: one type, paginated ("see all") ---
  if (type !== undefined) {
    const searchOne = TYPES[type];
    if (!searchOne) {
      // A bad ?type is the caller's mistake → 400 (same rule as a bad id
      // elsewhere), NOT a silent fallback to the bundle.
      return next({ status: 400, message: "Invalid search type" });
    }
    const { page, limit, skip } = parsePagination(req.query);
    const { items, total } = await searchOne({ q, limit, skip });
    return res.json({ query: q, type, results: items, page, limit, total });
  }

  // --- Mode A: bundle for the dropdown (all three groups at once, capped) ---
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
