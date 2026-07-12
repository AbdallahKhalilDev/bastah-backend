// Seeds a few demo SHOPS and LISTINGS so the price-comparison feature has real
// data to show: the same product priced differently across several shops.
//
// Like the other seeds, it's IDEMPOTENT — shops upsert by name, listings upsert
// by the (shop, product) pair (the same combo the unique index protects), so
// re-running never creates duplicates. Run `npm run seed:products` first so the
// products these listings point at exist.

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");
const Shop = require("../models/Shop");
const Product = require("../models/Product");
const Listing = require("../models/Listing");

// Four active demo shops in different Gaza areas. ratingAvg/ratingCount are
// normally maintained by reviews (Step 7); we set them here only so the demo
// comparison output looks realistic.
const demoShops = [
  { name: "Al-Rimal Market", area: "Rimal", phone: "059-100-1001", ratingAvg: 4.5, ratingCount: 12 },
  { name: "Gaza Central Store", area: "Downtown", phone: "059-100-1002", ratingAvg: 4.8, ratingCount: 30 },
  { name: "Khan Younis Bazaar", area: "Khan Younis", phone: "059-100-1003", ratingAvg: 4.2, ratingCount: 8 },
  { name: "Nuseirat Corner Shop", area: "Nuseirat", phone: "059-100-1004", ratingAvg: 4.6, ratingCount: 17 },
];

// Which shops sell which product, and at what price (in ₪). Several products are
// priced in multiple shops on purpose — that's what makes "compare prices" show
// something. Prices are intentionally out of order so you can see the endpoint
// sort them cheapest-first.
const demoListings = {
  "Headphones": [
    { shop: "Al-Rimal Market", price: 120 },
    { shop: "Gaza Central Store", price: 99 },
    { shop: "Khan Younis Bazaar", price: 135 },
  ],
  "Bluetooth Speaker": [
    { shop: "Gaza Central Store", price: 150 },
    { shop: "Nuseirat Corner Shop", price: 139 },
  ],
  "Power Bank": [
    { shop: "Al-Rimal Market", price: 80 },
    { shop: "Khan Younis Bazaar", price: 75 },
    { shop: "Nuseirat Corner Shop", price: 85 },
  ],
  "Football": [
    { shop: "Gaza Central Store", price: 45 },
    { shop: "Nuseirat Corner Shop", price: 39 },
    { shop: "Al-Rimal Market", price: 50 },
  ],
  "Water Bottle": [
    { shop: "Al-Rimal Market", price: 10 },
    { shop: "Gaza Central Store", price: 8 },
    { shop: "Khan Younis Bazaar", price: 12, inStock: false },
    { shop: "Nuseirat Corner Shop", price: 9 },
  ],
  "Vitamin C Tablets": [
    { shop: "Al-Rimal Market", price: 25 },
    { shop: "Khan Younis Bazaar", price: 22 },
  ],
  "LED Lamp": [
    { shop: "Al-Rimal Market", price: 40 },
    { shop: "Khan Younis Bazaar", price: 38 },
  ],
  "Men's T-Shirt": [
    { shop: "Gaza Central Store", price: 30 },
    { shop: "Al-Rimal Market", price: 35 },
    { shop: "Nuseirat Corner Shop", price: 28 },
  ],
};

async function seedListings() {
  await connectDB();

  // A demo seller to own the shops. Its password is a placeholder — this account
  // isn't meant to be logged into, it just satisfies Shop's required `owner`.
  const seller = await User.findOneAndUpdate(
    { email: "demo.seller@bastah.local" },
    { $set: { name: "Demo Seller", role: "seller", passwordHash: "seeded-not-loginable" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Upsert the shops and remember each by name.
  const shopByName = new Map();
  for (const s of demoShops) {
    const shop = await Shop.findOneAndUpdate(
      { name: s.name },
      { $set: { owner: seller._id, area: s.area, phone: s.phone, ratingAvg: s.ratingAvg, ratingCount: s.ratingCount, isActive: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    shopByName.set(s.name, shop);
  }

  // Upsert the listings, looking up each product by name.
  let listingCount = 0;
  const missing = [];
  for (const [productName, entries] of Object.entries(demoListings)) {
    const product = await Product.findOne({ name: productName });
    if (!product) {
      missing.push(productName);
      continue;
    }
    for (const e of entries) {
      const shop = shopByName.get(e.shop);
      await Listing.findOneAndUpdate(
        { shop: shop._id, product: product._id },
        { $set: { price: e.price, inStock: e.inStock !== undefined ? e.inStock : true } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      listingCount++;
    }
  }

  console.log(`Seeded ${demoShops.length} shops and ${listingCount} listings`);
  if (missing.length) {
    console.log(`(Skipped — product not found: ${missing.join(", ")}. Run npm run seed:products first.)`);
  }

  // Print a couple of ready-to-open URLs for products priced in several shops.
  for (const name of ["Headphones", "Water Bottle"]) {
    const p = await Product.findOne({ name });
    if (p) console.log(`Try: http://localhost:3000/api/products/${p._id}/listings   (${name})`);
  }

  await mongoose.disconnect();
}

seedListings().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
