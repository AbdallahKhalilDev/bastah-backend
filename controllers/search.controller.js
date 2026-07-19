const { DROPDOWN_LIMIT, searchProducts } = require("../utils/searchQueries");

// GET /api/search
// Public, read-only. The "search everything" box.
//
// Built in slices. RIGHT NOW (Slice 1) it returns the BUNDLE for the type-ahead
// dropdown with just PRODUCTS: a small capped list plus `counts` (the grand total
// of matches) so the UI can show "See all 42 products". Slices 2–3 add shops and
// categories to the bundle; Slice 4 adds the paginated ?type= "see all" mode.
//
// An empty/whitespace q is NOT an error — there's simply nothing to show yet, so
// the group comes back empty with a zero count (the helper handles this).
async function search(req, res, next) {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const products = await searchProducts({ q, limit: DROPDOWN_LIMIT });

  res.json({
    query: q,
    products: products.items,
    // Grand total per group, so a frontend can render "See all N".
    counts: {
      products: products.total,
    },
  });
}

module.exports = { search };
