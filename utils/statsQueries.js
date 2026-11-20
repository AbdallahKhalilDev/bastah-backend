// The dashboard NUMBERS, written ONCE.
//
// Every function takes a `filter` on the `shop` field, the same idea as the
// order inbox:
//   seller → { shop: { $in: myShopIds } } or { shop: oneOfMyShops }
//   admin  → {}   (the whole marketplace; used by the admin's numbers later)
// So the seller's cards and the admin's cards can never count the same thing in
// two different ways.
//
// Numbers are counted fresh on every request, never stored. At Bastah's size
// that's fast, and a number that is never stored can never go out of date.
const Order = require("../models/Order");
const Listing = require("../models/Listing");
const { ORDER_STATUSES, money } = require("./orderQueries");
const { startOfGazaDay } = require("./gazaTime");
const { staleFilter, DEFAULT_STALE_DAYS } = require("./sellerQueries");

// How many best-selling products the "top products" card shows.
const TOP_PRODUCTS_LIMIT = 5;

// --- small building blocks ------------------------------------------------

// How many orders there are in each status, ALL TIME, e.g. { pending: 3, … }.
// `pending` is the number on the inbox badge.
//
// $group by a FIELD: `recalcShopRating` used `_id: null` to squash every review
// into ONE row. Here `_id: "$status"` makes one row PER STATUS instead:
//   [{ _id: "pending", count: 3 }, { _id: "completed", count: 20 }]
// A status with no orders gets no row at all, so we start from a zero for every
// status and fill in what came back. The frontend always gets all six keys.
async function countByStatus(filter) {
  const rows = await Order.aggregate([
    { $match: filter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const row of rows) {
    byStatus[row._id] = row.count;
  }
  return byStatus;
}

// The value (₪) of the orders COMPLETED since `since`: the sum of their `total`
// (items + delivery fee). Not "revenue": no money passes through Bastah, this is
// what customers paid the shop in cash, outside the app.
//
// When was an order completed? We don't store that, but `completed` is a FINAL
// status: once an order is completed, nothing ever changes it again. So the last
// time it changed (`updatedAt`) IS the moment it was completed. If a future
// feature ever writes to completed orders, add a real `completedAt` field.
async function completedValueSince(filter, since) {
  const [row] = await Order.aggregate([
    { $match: { ...filter, status: "completed", updatedAt: { $gte: since } } },
    { $group: { _id: null, value: { $sum: "$total" } } },
  ]);
  // money() rounds to 2 decimals: adding up prices like 19.99 can leave
  // computer leftovers such as 95.49000000000001.
  return money(row ? row.value : 0);
}

// The best sellers: products by quantity sold in COMPLETED orders since `since`.
//
// NEW CONCEPT: $unwind. One order holds a LIST of lines (items). $group can only
// add up whole documents, so first $unwind turns one order with 3 lines into 3
// separate documents, one per line. Then we $group those lines by product and
// add up their quantities.
//
// The names come from the order lines themselves, which froze the product's
// name at checkout, so this still works if a listing was deleted since.
async function topProductsSince(filter, since) {
  return Order.aggregate([
    { $match: { ...filter, status: "completed", updatedAt: { $gte: since } } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product",
        // Every line of one product carries the same frozen name, so taking
        // the first one is enough.
        productName: { $first: "$items.productName" },
        productNameAr: { $first: "$items.productNameAr" },
        unit: { $first: "$items.unit" },
        quantity: { $sum: "$items.quantity" },
      },
    },
    // Most sold first; the product id breaks ties so the order never wobbles.
    { $sort: { quantity: -1, _id: 1 } },
    { $limit: TOP_PRODUCTS_LIMIT },
    // Rename _id to `product` for the reply (0 = leave out, 1 = keep).
    {
      $project: {
        _id: 0,
        product: "$_id",
        productName: 1,
        productNameAr: 1,
        unit: 1,
        quantity: 1,
      },
    },
  ]);
}

// --- what the dashboards call ------------------------------------------------

// The order cards. The time windows are Gaza calendar days:
//   today      = since midnight today, Gaza time
//   last7Days  = today + the 6 days before it
//   last30Days = today + the 29 days before it
// "Orders" counts orders PLACED in the window (any status, cancelled included);
// the value and the top products count orders COMPLETED in the window.
async function getOrderStats(filter) {
  const today = startOfGazaDay(0);
  const week = startOfGazaDay(6);
  const month = startOfGazaDay(29);

  // All the questions at once, in parallel, like /api/home.
  const [
    byStatus,
    placedToday,
    placedWeek,
    placedMonth,
    valueToday,
    valueWeek,
    valueMonth,
    topProducts,
  ] = await Promise.all([
    countByStatus(filter),
    Order.countDocuments({ ...filter, createdAt: { $gte: today } }),
    Order.countDocuments({ ...filter, createdAt: { $gte: week } }),
    Order.countDocuments({ ...filter, createdAt: { $gte: month } }),
    completedValueSince(filter, today),
    completedValueSince(filter, week),
    completedValueSince(filter, month),
    topProductsSince(filter, month),
  ]);

  return {
    orders: {
      byStatus,
      today: placedToday,
      last7Days: placedWeek,
      last30Days: placedMonth,
    },
    completedValue: {
      today: valueToday,
      last7Days: valueWeek,
      last30Days: valueMonth,
    },
    topProducts,
  };
}

// The item cards: how many items, how many out of stock, how many with an old
// price. `staleDays` is in the reply so the dashboard can label the card and
// link it to GET /api/seller/listings?staleDays=<same number>.
async function getListingStats(filter) {
  const [total, outOfStock, stale] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.countDocuments({ ...filter, inStock: false }),
    Listing.countDocuments({ ...filter, ...staleFilter(DEFAULT_STALE_DAYS) }),
  ]);
  return { total, outOfStock, stale, staleDays: DEFAULT_STALE_DAYS };
}

module.exports = { getOrderStats, getListingStats, TOP_PRODUCTS_LIMIT };
