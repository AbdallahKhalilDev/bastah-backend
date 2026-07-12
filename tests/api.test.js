// Lightweight end-to-end tests for the Products + Listings endpoints.
//
// How it works, in plain language:
//   1. It points the app at a SEPARATE database ("bastah_test"), so your real
//      "bastah" data is never touched. It wipes that test DB clean each run.
//   2. It seeds a few rows directly (a category, some users, some shops) and
//      mints login tokens, so we have something to act on.
//   3. It starts the real Express app on a random free port and calls the
//      endpoints over HTTP exactly like Postman would — then checks the status
//      code and response body of each call.
//   4. It prints a ✓ or ✗ per check and exits non-zero if anything failed, then
//      drops the test DB and shuts down.
//
// Run it with:  npm test   (your local MongoDB must be running, same as dev).

// Set config BEFORE requiring the app. We use a throwaway DB name and a fixed
// test secret so the tokens we mint below verify against the same secret the
// auth middleware reads.
process.env.MONGO_URI =
  process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27017/bastah_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const app = require("../app");

const Category = require("../models/Category");
const User = require("../models/User");
const Shop = require("../models/Shop");

// --- tiny test helpers --------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name);
  }
}

let base = ""; // filled in once the server is listening
async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* some responses have no body */
  }
  return { status: res.status, body: json };
}

function tokenFor(user) {
  return jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET);
}

// A well-formed ObjectId that doesn't exist in the DB — for "not found" tests.
const FAKE_ID = new mongoose.Types.ObjectId().toString();

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  await mongoose.connection.dropDatabase(); // start from a clean slate

  // Build indexes now (important!): the unique (shop, product) index must exist
  // before we test that a duplicate listing is rejected with 409.
  const Listing = require("../models/Listing");
  const Product = require("../models/Product");
  await Promise.all([Listing.init(), Product.init(), Shop.init()]);

  // --- seed data ---
  const category = await Category.create({
    name: "Grocery",
    nameAr: "بقالة",
    slug: "grocery",
  });

  const seller = await User.create({
    name: "Seller",
    email: "seller@test.com",
    passwordHash: "x",
    role: "seller",
  });
  const otherSeller = await User.create({
    name: "Other Seller",
    email: "other@test.com",
    passwordHash: "x",
    role: "seller",
  });
  const admin = await User.create({
    name: "Admin",
    email: "admin@test.com",
    passwordHash: "x",
    role: "admin",
  });
  const customer = await User.create({
    name: "Customer",
    email: "customer@test.com",
    passwordHash: "x",
    role: "customer",
  });

  const shopA = await Shop.create({ owner: seller._id, name: "Shop A", phone: "1" });
  const shopB = await Shop.create({ owner: seller._id, name: "Shop B", phone: "2" });
  const otherShop = await Shop.create({
    owner: otherSeller._id,
    name: "Other Shop",
    phone: "3",
  });
  const inactiveShop = await Shop.create({
    owner: seller._id,
    name: "Hidden Shop",
    phone: "4",
    isActive: false,
  });

  const sellerToken = tokenFor(seller);
  const adminToken = tokenFor(admin);
  const customerToken = tokenFor(customer);

  // Start the real app on a random free port.
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = "http://localhost:" + server.address().port;

  // Silence the central error handler's console noise (our tests trigger many
  // expected 4xx errors). We keep the messages and only print them if a check
  // fails, so real surprises still surface.
  const originalError = console.error;
  const errorLog = [];
  console.error = (...args) => errorLog.push(args);

  try {
    // ================= Products: POST /api/products =================
    console.log("\nPOST /api/products");
    let r;

    r = await req("POST", "/api/products", { body: { name: "x", nameAr: "x", category: FAKE_ID } });
    check("no token → 401", r.status === 401);

    r = await req("POST", "/api/products", {
      token: customerToken,
      body: { name: "x", nameAr: "x", category: category.id },
    });
    check("customer role → 403", r.status === 403);

    r = await req("POST", "/api/products", {
      token: sellerToken,
      body: { name: "Sugar", category: category.id },
    });
    check("missing nameAr → 400", r.status === 400);

    r = await req("POST", "/api/products", {
      token: sellerToken,
      body: { name: "Sugar", nameAr: "سكر", category: "abc" },
    });
    check("invalid category id → 400", r.status === 400 && r.body.error === "Invalid category id");

    r = await req("POST", "/api/products", {
      token: sellerToken,
      body: { name: "Sugar", nameAr: "سكر", category: FAKE_ID },
    });
    check("category not found → 400", r.status === 400 && r.body.error === "Category not found");

    r = await req("POST", "/api/products", {
      token: sellerToken,
      body: { name: "Sugar", nameAr: "سكر", category: category.id, unit: "kg" },
    });
    check("valid → 201", r.status === 201);
    check("returns product with category populated", r.body?.product?.category?.name === "Grocery");
    const productId = r.body?.product?._id;

    // ============ Listings: POST /api/shops/:shopId/listings ============
    console.log("\nPOST /api/shops/:shopId/listings");

    r = await req("POST", `/api/shops/${shopA.id}/listings`, {
      token: sellerToken,
      body: { product: productId, price: 5 },
    });
    check("create in shop A (price 5) → 201", r.status === 201);
    check("inStock defaults to true", r.body?.listing?.inStock === true);
    check("product populated in response", r.body?.listing?.product?.name === "Sugar");

    r = await req("POST", `/api/shops/${shopB.id}/listings`, {
      token: sellerToken,
      body: { product: productId, price: 6, inStock: true },
    });
    check("same product in shop B (price 6) → 201", r.status === 201);
    const shopBListingId = r.body?.listing?._id; // used by the update/delete tests

    r = await req("POST", `/api/shops/${shopA.id}/listings`, {
      token: sellerToken,
      body: { product: productId, price: 7 },
    });
    check("duplicate (same shop+product) → 409", r.status === 409);

    r = await req("POST", "/api/shops/abc/listings", {
      token: sellerToken,
      body: { product: productId, price: 5 },
    });
    check("invalid shop id → 400", r.status === 400 && r.body.error === "Invalid shop id");

    r = await req("POST", `/api/shops/${FAKE_ID}/listings`, {
      token: sellerToken,
      body: { product: productId, price: 5 },
    });
    check("shop not found → 404", r.status === 404);

    r = await req("POST", `/api/shops/${otherShop.id}/listings`, {
      token: sellerToken,
      body: { product: productId, price: 5 },
    });
    check("seller adding to a shop they don't own → 403", r.status === 403);

    r = await req("POST", `/api/shops/${shopA.id}/listings`, {
      token: sellerToken,
      body: { product: "abc", price: 5 },
    });
    check("invalid product id → 400", r.status === 400 && r.body.error === "Invalid product id");

    r = await req("POST", `/api/shops/${shopA.id}/listings`, {
      token: sellerToken,
      body: { product: FAKE_ID, price: 5 },
    });
    check("product not found → 400", r.status === 400 && r.body.error === "Product not found");

    r = await req("POST", `/api/shops/${shopB.id}/listings`, {
      token: sellerToken,
      body: { product: productId, price: -1 },
    });
    check("negative price → 400", r.status === 400);

    r = await req("POST", `/api/shops/${shopB.id}/listings`, {
      token: sellerToken,
      body: { product: productId },
    });
    check("missing price → 400", r.status === 400);

    r = await req("POST", `/api/shops/${otherShop.id}/listings`, {
      token: adminToken,
      body: { product: productId, price: 9 },
    });
    check("admin can add to any shop → 201", r.status === 201);
    const otherShopListingId = r.body?.listing?._id; // owned by otherSeller

    // ================= Update: PATCH /api/listings/:id =================
    console.log("\nPATCH /api/listings/:id");

    r = await req("PATCH", `/api/listings/${shopBListingId}`, { body: { price: 8 } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", `/api/listings/${shopBListingId}`, {
      token: customerToken,
      body: { price: 8 },
    });
    check("customer role → 403", r.status === 403);

    r = await req("PATCH", "/api/listings/abc", { token: sellerToken, body: { price: 8 } });
    check("invalid listing id → 400", r.status === 400 && r.body.error === "Invalid listing id");

    r = await req("PATCH", `/api/listings/${FAKE_ID}`, { token: sellerToken, body: { price: 8 } });
    check("listing not found → 404", r.status === 404);

    r = await req("PATCH", `/api/listings/${otherShopListingId}`, {
      token: sellerToken,
      body: { price: 8 },
    });
    check("editing another seller's listing → 403", r.status === 403);

    r = await req("PATCH", `/api/listings/${shopBListingId}`, {
      token: sellerToken,
      body: { price: -1 },
    });
    check("negative price → 400", r.status === 400);

    r = await req("PATCH", `/api/listings/${shopBListingId}`, {
      token: sellerToken,
      body: { price: 8, inStock: false },
    });
    check("update price + inStock → 200", r.status === 200);
    check("price updated to 8", r.body?.listing?.price === 8);
    check("inStock updated to false", r.body?.listing?.inStock === false);

    r = await req("PATCH", `/api/listings/${shopBListingId}`, {
      token: sellerToken,
      body: { shop: shopA.id, product: FAKE_ID, price: 10 },
    });
    check("shop/product in body are ignored → 200", r.status === 200);
    check("shop unchanged (still shop B)", String(r.body?.listing?.shop) === String(shopB.id));
    check("product unchanged", String(r.body?.listing?.product?._id) === String(productId));

    // ================= Delete: DELETE /api/listings/:id =================
    console.log("\nDELETE /api/listings/:id");

    r = await req("DELETE", `/api/listings/${shopBListingId}`);
    check("no token → 401", r.status === 401);

    r = await req("DELETE", "/api/listings/abc", { token: sellerToken });
    check("invalid listing id → 400", r.status === 400);

    r = await req("DELETE", `/api/listings/${FAKE_ID}`, { token: sellerToken });
    check("listing not found → 404", r.status === 404);

    r = await req("DELETE", `/api/listings/${otherShopListingId}`, { token: sellerToken });
    check("deleting another seller's listing → 403", r.status === 403);

    r = await req("DELETE", `/api/listings/${shopBListingId}`, { token: sellerToken });
    check("delete own listing → 200", r.status === 200);

    r = await req("DELETE", `/api/listings/${shopBListingId}`, { token: sellerToken });
    check("deleting it again → 404 (it's really gone)", r.status === 404);

    // =========== A shop's products: GET /api/shops/:shopId/products ===========
    console.log("\nGET /api/shops/:shopId/products");

    // Public — no token needed. Shop A still has its sugar listing (price 5).
    r = await req("GET", `/api/shops/${shopA.id}/products`);
    check("public (no token) → 200", r.status === 200);
    check("returns an array of listings", Array.isArray(r.body?.listings));
    const sugarListing = r.body?.listings?.find((l) => l.product?.name === "Sugar");
    check("listing carries its product, populated", sugarListing?.product?.nameAr === "سكر");
    check("listing carries price and inStock", sugarListing?.price === 5 && sugarListing?.inStock === true);

    // Shop B's only listing was deleted above, so it has none now.
    r = await req("GET", `/api/shops/${shopB.id}/products`);
    check("shop with no listings → 200 with []", r.status === 200 && Array.isArray(r.body.listings) && r.body.listings.length === 0);

    r = await req("GET", "/api/shops/abc/products");
    check("invalid shop id → 400", r.status === 400 && r.body.error === "Invalid shop id");

    r = await req("GET", `/api/shops/${FAKE_ID}/products`);
    check("shop not found → 404", r.status === 404);

    r = await req("GET", `/api/shops/${inactiveShop.id}/products`);
    check("inactive shop is hidden → 404", r.status === 404);
  } finally {
    console.error = originalError;
    if (failed > 0 && errorLog.length) {
      console.log("\n--- server error log ---");
      errorLog.forEach((a) => originalError(...a));
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
