const Area = require("../models/Area");

// GET /api/areas
// Public. Returns every ACTIVE area, sorted by English name. This is what fills
// the area picker at checkout and the "which areas do you deliver to?" screen in
// the seller's settings.
//
// There is deliberately no GET /api/areas/:id. Nothing needs to look up a single
// area by id — the client fetches the whole list once (it's ~26 rows) and keeps
// it. A nice side effect: with no "/:id" route in this file, there's no
// route-ordering hazard to think about at all.
async function listAreas(req, res, next) {
  // find({ isActive: true }) hides any area we've retired. An empty list is a
  // correct, successful answer (200), not an error — it just means nobody has
  // run `npm run seed:areas` yet.
  const areas = await Area.find({ isActive: true }).sort({ name: 1 });
  res.json({ areas });
}

module.exports = { listAreas };
