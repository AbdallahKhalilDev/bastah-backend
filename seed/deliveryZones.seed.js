// A CONVENIENCE seed for development and demos: give EVERY shop a delivery zone
// for EVERY area, so that every shop delivers everywhere.
//
// Why this exists: while building the frontend, having to configure zones by
// hand for each shop before you can test a delivery checkout is tedious, and a
// "<Shop> does not deliver to <Area>" 409 in the middle of a demo is noise.
// After running this, any shop can deliver to any area.
//
// IMPORTANT — this is TEST DATA, not a product decision:
//   * It does NOT change any endpoint or any rule. Coverage is still enforced at
//     checkout exactly as before; it just never fails, because every shop now
//     covers every area. Remove a zone (or run `PATCH .../delivery-zones` with a
//     shorter list) and the 409 comes straight back.
//   * It REPLACES each shop's existing zones, exactly like the PATCH endpoint
//     does. If a seller has configured real zones, this overwrites them.
//   * Shops created AFTER you run it won't have zones. Just run it again — it's
//     idempotent, so re-running is always safe.
//
// Run it with:  npm run seed:delivery-zones
// Flat fee:     npm run seed:delivery-zones -- 5     (every zone costs ₪5)

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Shop = require("../models/Shop");
const Area = require("../models/Area");

// By default we cycle through these fees rather than setting one flat number,
// so the frontend has something interesting to render: some areas are free,
// some cost money. A fee of 0 is a real value meaning FREE delivery — it is not
// the same as "no zone", which means the shop doesn't go there at all.
const DEFAULT_FEES = [0, 5, 10, 15];

async function seedDeliveryZones() {
  await connectDB();

  // An optional flat fee from the command line: `npm run seed:delivery-zones -- 5`
  // (process.argv[2] is the first argument after the script name.)
  const flatFeeArg = process.argv[2];
  const flatFee = flatFeeArg === undefined ? null : Number(flatFeeArg);
  if (flatFee !== null && (!Number.isFinite(flatFee) || flatFee < 0)) {
    console.error(`"${flatFeeArg}" is not a valid fee. Use a number >= 0.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Only ACTIVE areas — a retired area shouldn't be offered to anyone.
  const areas = await Area.find({ isActive: true }).sort({ name: 1 });
  if (areas.length === 0) {
    console.error("No areas found. Run `npm run seed:areas` first.");
    await mongoose.disconnect();
    process.exit(1);
  }

  // Build the zone list once — it's identical for every shop.
  const zones = areas.map((area, i) => ({
    area: area._id,
    fee: flatFee !== null ? flatFee : DEFAULT_FEES[i % DEFAULT_FEES.length],
  }));

  // Every shop, including inactive ones (they may be switched back on later).
  const shops = await Shop.find({});
  for (const shop of shops) {
    // $set replaces the whole array, the same "set outright" meaning the PATCH
    // endpoint has. Running this twice writes the same value, so it's idempotent.
    await Shop.updateOne({ _id: shop._id }, { $set: { deliveryZones: zones } });
  }

  const feeNote =
    flatFee !== null
      ? `a flat fee of ₪${flatFee}`
      : `cycling fees (${DEFAULT_FEES.map((f) => "₪" + f).join(", ")})`;
  console.log(
    `Gave ${shops.length} shop(s) delivery zones for all ${areas.length} areas, with ${feeNote}`
  );
  console.log("Every shop now delivers everywhere. This is test data — the");
  console.log("coverage rule is unchanged, it simply never fails now.");

  await mongoose.disconnect();
}

seedDeliveryZones().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
