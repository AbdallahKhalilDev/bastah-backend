const homeQueries = require("../utils/homeQueries");

// GET /api/home
// Public, read-only. ONE request that returns everything the homepage's three
// strips need: featured offers, new arrivals, and top stores.
//
// Why bundle them? The homepage shows all three lists at once. Without this
// endpoint the frontend would fire THREE separate requests and juggle three
// loading/error states; with it, that's a single round-trip and one thing to wait
// on — simpler frontend code and a faster first paint.
//
// Crucially, this calls the SAME shared helpers as the standalone endpoints
// (/api/products/featured, /api/products/new, /api/shops/top). It doesn't
// re-implement any query, so the bundled data can never drift apart from the
// individual endpoints. We use small, homepage-sized limits (8 each), and run the
// three queries in PARALLEL with Promise.all because none depends on the others —
// so the whole thing takes about as long as the single slowest query, not the sum.
async function getHome(req, res, next) {
  const [featured, newArrivals, topStores] = await Promise.all([
    homeQueries.getFeaturedProducts({ limit: 8 }),
    homeQueries.getNewArrivals({ limit: 8 }),
    homeQueries.getTopStores({ limit: 8 }),
  ]);
  res.json({ featured, newArrivals, topStores });
}

module.exports = { getHome };
