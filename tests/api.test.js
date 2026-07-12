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
  const Review = require("../models/Review");
  const Cart = require("../models/Cart");
  await Promise.all([
    Listing.init(),
    Product.init(),
    Shop.init(),
    Review.init(),
    Cart.init(),
  ]);

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
  const customer2 = await User.create({
    name: "Second Customer",
    email: "customer2@test.com",
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
  const customer2Token = tokenFor(customer2);

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

    // ================= Browse: GET /api/products =================
    console.log("\nGET /api/products (browse, paginated)");

    // So far only "Sugar" exists. Add 4 more directly so we have 5 products to
    // page through with known totals.
    for (const n of ["Rice", "Salt", "Flour", "Tea"]) {
      await Product.create({ name: n, nameAr: n, category: category._id });
    }

    r = await req("GET", "/api/products?limit=2");
    check("limit=2 → 2 products", Array.isArray(r.body?.products) && r.body.products.length === 2);
    check("echoes page=1, limit=2", r.body?.page === 1 && r.body?.limit === 2);
    check("total counts ALL products (5)", r.body?.total === 5);
    check(
      "category populated with name/nameAr only (no slug)",
      !!r.body.products[0]?.category?.name && r.body.products[0]?.category?.slug === undefined
    );

    r = await req("GET", "/api/products?page=3&limit=2");
    check("page 3 of limit 2 → 1 leftover product", r.body?.products?.length === 1 && r.body?.page === 3);

    r = await req("GET", "/api/products?limit=999");
    check("limit clamped to 50 (all 5 returned)", r.body?.limit === 50 && r.body?.products?.length === 5);

    // ================= Details: GET /api/products/:id =================
    console.log("\nGET /api/products/:id");

    r = await req("GET", `/api/products/${productId}`);
    check("valid id → 200 with category populated", r.status === 200 && r.body?.product?.category?.name === "Grocery");

    r = await req("GET", "/api/products/abc");
    check("invalid id → 400", r.status === 400 && r.body.error === "Invalid product id");

    r = await req("GET", `/api/products/${FAKE_ID}`);
    check("missing product → 404", r.status === 404);

    // ============ Comparison: GET /api/products/:id/listings ============
    console.log("\nGET /api/products/:id/listings (price comparison)");

    // List ONE product in three shops: active @5, active @3, and INACTIVE @1.
    // Expected: only the two active shops appear, ordered 3 then 5 — and the
    // inactive shop's cheaper price (1) must NOT sneak in.
    const cmpProduct = await Product.create({ name: "Compare Oil", nameAr: "زيت مقارنة", category: category._id });
    await Listing.create({ shop: shopA._id, product: cmpProduct._id, price: 5 });
    await Listing.create({ shop: shopB._id, product: cmpProduct._id, price: 3 });
    await Listing.create({ shop: inactiveShop._id, product: cmpProduct._id, price: 1 });

    r = await req("GET", `/api/products/${cmpProduct.id}/listings`);
    check("→ 200", r.status === 200);
    check("product summary included", r.body?.product?.name === "Compare Oil");
    check("only active shops' listings (2 of 3)", r.body?.listings?.length === 2);
    check("sorted cheapest first (3 then 5)", r.body?.listings?.[0]?.price === 3 && r.body?.listings?.[1]?.price === 5);
    check("inactive shop's cheaper price (1) excluded", !r.body.listings.some((l) => l.price === 1));
    check("shop carries safe public fields", !!r.body.listings[0]?.shop?.name && r.body.listings[0]?.shop?.phone !== undefined);
    check("no owner/isActive leaked on shop", r.body.listings[0]?.shop?.owner === undefined && r.body.listings[0]?.shop?.isActive === undefined);

    const lonelyProduct = await Product.create({ name: "Lonely Product", nameAr: "منتج وحيد", category: category._id });
    r = await req("GET", `/api/products/${lonelyProduct.id}/listings`);
    check("product nobody lists → 200 with []", r.status === 200 && Array.isArray(r.body.listings) && r.body.listings.length === 0);

    r = await req("GET", "/api/products/abc/listings");
    check("invalid id → 400", r.status === 400 && r.body.error === "Invalid product id");

    r = await req("GET", `/api/products/${FAKE_ID}/listings`);
    check("missing product → 404", r.status === 404);

    // ================= Search: GET /api/products/search =================
    console.log("\nGET /api/products/search");

    // Add a second category + a product in it, so category filtering separates
    // things (until now every product was in "Grocery").
    const cat2 = await Category.create({ name: "Electronics", nameAr: "إلكترونيات", slug: "electronics-test" });
    await Product.create({ name: "Phone Charger", nameAr: "شاحن هاتف", category: cat2._id });

    r = await req("GET", "/api/products/search?q=sug");
    check(
      "q=sug finds Sugar (partial, case-insensitive)",
      r.status === 200 &&
        r.body.products.some((p) => p.name === "Sugar") &&
        r.body.products.every((p) => /sug/i.test(p.name) || /sug/i.test(p.nameAr))
    );

    r = await req("GET", "/api/products/search?q=" + encodeURIComponent("("));
    check("q='(' does not crash (regex escaped) → 200", r.status === 200);

    r = await req("GET", `/api/products/search?category=${cat2._id}`);
    check(
      "filter by category → only that category's product",
      r.body?.total === 1 && r.body.products[0]?.name === "Phone Charger"
    );

    r = await req("GET", "/api/products/search?category=abc");
    check("bad category id → 400", r.status === 400 && r.body.error === "Invalid category id");

    r = await req("GET", "/api/products/search?sort=bogus");
    check("unknown sort falls back (200, not 500)", r.status === 200);

    r = await req("GET", "/api/products/search?sort=name&limit=50");
    const names = (r.body?.products || []).map((p) => p.name);
    let ascending = names.length > 1;
    for (let i = 1; i < names.length; i++) if (names[i] < names[i - 1]) ascending = false;
    check("sort=name returns A→Z order", ascending);

    r = await req("GET", `/api/products/search?q=charg&category=${cat2._id}`);
    check(
      "combined q + category narrows to Phone Charger",
      r.body?.total === 1 && r.body.products[0]?.name === "Phone Charger"
    );

    r = await req("GET", "/api/products/search?limit=2");
    check("pagination echoes in search", r.body?.limit === 2 && r.body?.products?.length === 2);

    // Proves the route ordering: /search reached searchProducts, not /:id
    // (if /:id had captured it, "search" would be an invalid id → 400).
    r = await req("GET", "/api/products/search");
    check("/search resolves to search, not /:id", r.status === 200 && Array.isArray(r.body?.products));

    // ============ Reviews: POST /api/shops/:shopId/reviews ============
    console.log("\nPOST /api/shops/:shopId/reviews");

    r = await req("POST", `/api/shops/${shopA.id}/reviews`, { body: { rating: 5 } });
    check("no token → 401", r.status === 401);

    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: sellerToken,
      body: { rating: 5 },
    });
    check("non-customer (seller) → 403", r.status === 403);

    r = await req("POST", "/api/shops/abc/reviews", {
      token: customerToken,
      body: { rating: 5 },
    });
    check("invalid shop id → 400", r.status === 400 && r.body.error === "Invalid shop id");

    r = await req("POST", `/api/shops/${FAKE_ID}/reviews`, {
      token: customerToken,
      body: { rating: 5 },
    });
    check("shop not found → 404", r.status === 404);

    r = await req("POST", `/api/shops/${inactiveShop.id}/reviews`, {
      token: customerToken,
      body: { rating: 5 },
    });
    check("inactive shop is hidden → 404", r.status === 404);

    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customerToken,
      body: { rating: 6 },
    });
    check("rating above 5 → 400", r.status === 400);

    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customerToken,
      body: { rating: 3.5 },
    });
    check("non-integer rating → 400", r.status === 400);

    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customerToken,
      body: { comment: "no stars" },
    });
    check("missing rating → 400", r.status === 400);

    // Customer 1 posts a valid 5-star review on shop A.
    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customerToken,
      body: { rating: 5, comment: "Great shop" },
    });
    check("customer posts review → 201", r.status === 201);
    check("returns the review with rating 5", r.body?.review?.rating === 5);
    const review1Id = r.body?.review?._id; // customer 1's review, used in Slice 4

    // Shop A's cached rating should now reflect that one review.
    r = await req("GET", `/api/shops/${shopA.id}`);
    check("shop ratingCount is now 1", r.body?.shop?.ratingCount === 1);
    check("shop ratingAvg is now 5", r.body?.shop?.ratingAvg === 5);

    // Same customer, same shop, again → blocked by the unique index.
    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customerToken,
      body: { rating: 4 },
    });
    check("same customer reviews same shop again → 409", r.status === 409);

    // A DIFFERENT customer reviews the same shop with 2 stars.
    r = await req("POST", `/api/shops/${shopA.id}/reviews`, {
      token: customer2Token,
      body: { rating: 2 },
    });
    check("second customer's review → 201", r.status === 201);
    const review2Id = r.body?.review?._id; // customer 2's review, used in Slice 4

    // Average of 5 and 2 is 3.5, across 2 reviews.
    r = await req("GET", `/api/shops/${shopA.id}`);
    check("two reviews → ratingCount 2", r.body?.shop?.ratingCount === 2);
    check("two reviews (5,2) → ratingAvg 3.5", r.body?.shop?.ratingAvg === 3.5);

    // ============ Reviews: GET /api/shops/:shopId/reviews ============
    console.log("\nGET /api/shops/:shopId/reviews");

    // Public — no token needed. Shop A has 2 reviews now.
    r = await req("GET", `/api/shops/${shopA.id}/reviews`);
    check("public (no token) → 200", r.status === 200);
    check("returns both reviews", Array.isArray(r.body?.reviews) && r.body.reviews.length === 2);
    check("total echoed as 2", r.body?.total === 2);
    // Newest first: customer2's review (rating 2) was posted last.
    check("newest first (rating 2 leads)", r.body?.reviews?.[0]?.rating === 2);
    check("author populated with name", r.body?.reviews?.[0]?.author?.name === "Second Customer");
    check("author email NOT leaked", r.body?.reviews?.[0]?.author?.email === undefined);

    // Shop B has no reviews.
    r = await req("GET", `/api/shops/${shopB.id}/reviews`);
    check("shop with no reviews → 200 with []", r.status === 200 && Array.isArray(r.body.reviews) && r.body.reviews.length === 0);

    // Pagination behaves like the product endpoints.
    r = await req("GET", `/api/shops/${shopA.id}/reviews?limit=1`);
    check("limit=1 → 1 review, total still 2", r.body?.reviews?.length === 1 && r.body?.total === 2);

    r = await req("GET", "/api/shops/abc/reviews");
    check("invalid shop id → 400", r.status === 400 && r.body.error === "Invalid shop id");

    r = await req("GET", `/api/shops/${FAKE_ID}/reviews`);
    check("shop not found → 404", r.status === 404);

    // ============ Reviews: PATCH /api/reviews/:id ============
    console.log("\nPATCH /api/reviews/:id");
    // State here: shop A has review1 (customer1, rating 5) + review2 (customer2,
    // rating 2); ratingAvg 3.5, ratingCount 2.

    r = await req("PATCH", `/api/reviews/${review1Id}`, { body: { rating: 3 } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", "/api/reviews/abc", { token: customerToken, body: { rating: 3 } });
    check("invalid review id → 400", r.status === 400 && r.body.error === "Invalid review id");

    r = await req("PATCH", `/api/reviews/${FAKE_ID}`, { token: customerToken, body: { rating: 3 } });
    check("review not found → 404", r.status === 404);

    r = await req("PATCH", `/api/reviews/${review1Id}`, {
      token: customer2Token,
      body: { rating: 1 },
    });
    check("editing someone else's review → 403", r.status === 403);

    r = await req("PATCH", `/api/reviews/${review1Id}`, {
      token: customerToken,
      body: { rating: 9 },
    });
    check("rating out of range → 400", r.status === 400);

    // Author lowers their own rating from 5 to 3.
    r = await req("PATCH", `/api/reviews/${review1Id}`, {
      token: customerToken,
      body: { rating: 3 },
    });
    check("author edits own review → 200", r.status === 200);
    check("rating updated to 3", r.body?.review?.rating === 3);

    // Shop average must re-sync: (3 + 2) / 2 = 2.5.
    r = await req("GET", `/api/shops/${shopA.id}`);
    check("edit re-syncs shop average to 2.5", r.body?.shop?.ratingAvg === 2.5);
    check("ratingCount still 2 after edit", r.body?.shop?.ratingCount === 2);

    // ============ Reviews: DELETE /api/reviews/:id ============
    console.log("\nDELETE /api/reviews/:id");

    r = await req("DELETE", `/api/reviews/${review2Id}`);
    check("no token → 401", r.status === 401);

    r = await req("DELETE", "/api/reviews/abc", { token: customerToken });
    check("invalid review id → 400", r.status === 400);

    r = await req("DELETE", `/api/reviews/${FAKE_ID}`, { token: customerToken });
    check("review not found → 404", r.status === 404);

    r = await req("DELETE", `/api/reviews/${review1Id}`, { token: customer2Token });
    check("deleting someone else's review (not admin) → 403", r.status === 403);

    // customer2 deletes their OWN review (rating 2). Shop A now has only review1
    // (rating 3): average 3, count 1.
    r = await req("DELETE", `/api/reviews/${review2Id}`, { token: customer2Token });
    check("author deletes own review → 200", r.status === 200);

    r = await req("GET", `/api/shops/${shopA.id}`);
    check("delete re-syncs: ratingCount 1", r.body?.shop?.ratingCount === 1);
    check("delete re-syncs: ratingAvg 3", r.body?.shop?.ratingAvg === 3);

    // An ADMIN deletes review1 (customer1's) — the LAST review on shop A.
    r = await req("DELETE", `/api/reviews/${review1Id}`, { token: adminToken });
    check("admin deletes another user's review → 200", r.status === 200);

    // Removing the last review returns the shop cleanly to 0 / 0.
    r = await req("GET", `/api/shops/${shopA.id}`);
    check("last review gone → ratingCount 0", r.body?.shop?.ratingCount === 0);
    check("last review gone → ratingAvg 0", r.body?.shop?.ratingAvg === 0);

    // ======================= Cart fixtures ==========================
    // A couple of real, ACTIVE listings in two DIFFERENT shops, so the cart tests
    // can prove that items from multiple shops coexist. Created directly (we've
    // already tested the listing endpoints above).
    const cartProductA = await Product.create({
      name: "Cart Milk",
      nameAr: "حليب",
      category: category._id,
      unit: "L",
    });
    const cartProductB = await Product.create({
      name: "Cart Bread",
      nameAr: "خبز",
      category: category._id,
      unit: "piece",
    });
    // shopA is active; otherShop is active — two different shops.
    const cartListingA = await Listing.create({
      shop: shopA._id,
      product: cartProductA._id,
      price: 10,
    });
    const cartListingB = await Listing.create({
      shop: otherShop._id,
      product: cartProductB._id,
      price: 4,
    });

    // ================= Cart: GET /api/cart =================
    console.log("\nGET /api/cart");

    r = await req("GET", "/api/cart");
    check("no token → 401", r.status === 401);

    r = await req("GET", "/api/cart", { token: sellerToken });
    check("non-customer (seller) → 403", r.status === 403);

    // `customer` has never touched their cart → no cart document yet. That's an
    // empty cart (200), NOT a 404.
    r = await req("GET", "/api/cart", { token: customerToken });
    check("new customer with no cart → 200", r.status === 200);
    check("empty cart shape { cart: { items: [] } }", Array.isArray(r.body?.cart?.items) && r.body.cart.items.length === 0);

    // Seed a THROWAWAY customer's cart directly (one item, qty 2) to prove the
    // populated read shape without needing the POST endpoint (that's Slice 3).
    const seedCustomer = await User.create({
      name: "Seed Customer",
      email: "seed@test.com",
      passwordHash: "x",
      role: "customer",
    });
    const seedCustomerToken = tokenFor(seedCustomer);
    await Cart.create({
      customer: seedCustomer._id,
      items: [{ listing: cartListingA._id, quantity: 2 }],
    });

    r = await req("GET", "/api/cart", { token: seedCustomerToken });
    check("seeded cart → 200", r.status === 200);
    check("cart has 1 item with quantity 2", r.body?.cart?.items?.length === 1 && r.body.cart.items[0].quantity === 2);
    const seedItem = r.body?.cart?.items?.[0];
    check("item shows the LIVE listing price (10)", seedItem?.listing?.price === 10);
    check("item's product populated (name/nameAr)", seedItem?.listing?.product?.name === "Cart Milk" && seedItem?.listing?.product?.nameAr === "حليب");
    check("item's shop populated with safe fields", seedItem?.listing?.shop?.name === "Shop A" && seedItem?.listing?.shop?.phone !== undefined);
    check("no owner leaked on the shop", seedItem?.listing?.shop?.owner === undefined);

    // ================= Cart: POST /api/cart/items =================
    console.log("\nPOST /api/cart/items");
    // `customer` still has no cart (the GET above didn't create one). We build it
    // up here. Helper to find a line by its product name in the returned cart.
    const findItem = (body, name) =>
      body?.cart?.items?.find((i) => i.listing?.product?.name === name);

    r = await req("POST", "/api/cart/items", { body: { listing: cartListingA.id } });
    check("no token → 401", r.status === 401);

    r = await req("POST", "/api/cart/items", {
      token: sellerToken,
      body: { listing: cartListingA.id },
    });
    check("non-customer (seller) → 403", r.status === 403);

    r = await req("POST", "/api/cart/items", { token: customerToken, body: {} });
    check("missing listing → 400", r.status === 400);

    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: "abc" },
    });
    check("invalid listing id → 400", r.status === 400 && r.body.error === "Invalid listing id");

    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: FAKE_ID },
    });
    check("listing not found → 400 (not a 500)", r.status === 400 && r.body.error === "Listing not found");

    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingA.id, quantity: 0 },
    });
    check("quantity 0 → 400", r.status === 400);

    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingA.id, quantity: 1.5 },
    });
    check("non-integer quantity → 400", r.status === 400);

    // First add of listing A (no quantity → defaults to 1). Creates the cart.
    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingA.id },
    });
    check("add listing A → 201", r.status === 201);
    check("cart now has 1 item", r.body?.cart?.items?.length === 1);
    check("listing A quantity is 1", findItem(r.body, "Cart Milk")?.quantity === 1);
    check("item shows live price (10)", findItem(r.body, "Cart Milk")?.listing?.price === 10);

    // Add the SAME listing again with no quantity → quantity ADDS (1 → 2).
    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingA.id },
    });
    check("re-add same listing → still 1 item (no duplicate line)", r.body?.cart?.items?.length === 1);
    check("quantity incremented to 2", findItem(r.body, "Cart Milk")?.quantity === 2);

    // Add the same listing with quantity 3 → adds again (2 → 5).
    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingA.id, quantity: 3 },
    });
    check("adding quantity 3 → total 5", findItem(r.body, "Cart Milk")?.quantity === 5);

    // Add listing B, which is in a DIFFERENT shop → both items coexist.
    r = await req("POST", "/api/cart/items", {
      token: customerToken,
      body: { listing: cartListingB.id },
    });
    check("add listing from another shop → 2 items", r.body?.cart?.items?.length === 2);
    check("both shops represented", findItem(r.body, "Cart Milk")?.listing?.shop?.name === "Shop A" && findItem(r.body, "Cart Bread")?.listing?.shop?.name === "Other Shop");
    check("listing B shows its own live price (4)", findItem(r.body, "Cart Bread")?.listing?.price === 4);

    // ============ Cart: PATCH /api/cart/items/:listingId ============
    console.log("\nPATCH /api/cart/items/:listingId");
    // State: customer's cart = Cart Milk x5, Cart Bread x1.

    r = await req("PATCH", `/api/cart/items/${cartListingA.id}`, { body: { quantity: 2 } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", `/api/cart/items/${cartListingA.id}`, {
      token: sellerToken,
      body: { quantity: 2 },
    });
    check("non-customer (seller) → 403", r.status === 403);

    r = await req("PATCH", "/api/cart/items/abc", {
      token: customerToken,
      body: { quantity: 2 },
    });
    check("invalid listing id → 400", r.status === 400 && r.body.error === "Invalid listing id");

    r = await req("PATCH", `/api/cart/items/${cartListingA.id}`, {
      token: customerToken,
      body: {},
    });
    check("missing quantity → 400", r.status === 400);

    r = await req("PATCH", `/api/cart/items/${cartListingA.id}`, {
      token: customerToken,
      body: { quantity: 0 },
    });
    check("quantity 0 → 400", r.status === 400);

    // A well-formed listing id that isn't in the cart → 404 (can't set what isn't there).
    r = await req("PATCH", `/api/cart/items/${FAKE_ID}`, {
      token: customerToken,
      body: { quantity: 2 },
    });
    check("listing not in cart → 404", r.status === 404);

    // SET Cart Milk from 5 to 2 (proves PATCH sets, it doesn't add).
    r = await req("PATCH", `/api/cart/items/${cartListingA.id}`, {
      token: customerToken,
      body: { quantity: 2 },
    });
    check("set quantity → 200", r.status === 200);
    check("Cart Milk quantity is now exactly 2 (set, not added)", findItem(r.body, "Cart Milk")?.quantity === 2);
    check("Cart Bread untouched (still 1)", findItem(r.body, "Cart Bread")?.quantity === 1);

    // ============ Cart isolation: one customer can't touch another's ============
    console.log("\nCart isolation (per-customer)");
    // customer2 has no cart yet; they add Cart Bread x7 to THEIR OWN cart.
    r = await req("POST", "/api/cart/items", {
      token: customer2Token,
      body: { listing: cartListingB.id, quantity: 7 },
    });
    check("customer2 builds their own cart → 201", r.status === 201);
    check("customer2 cart has just their 1 item (qty 7)", r.body?.cart?.items?.length === 1 && findItem(r.body, "Cart Bread")?.quantity === 7);

    // customer1's cart is completely unaffected by customer2's activity.
    r = await req("GET", "/api/cart", { token: customerToken });
    check("customer1 still sees their OWN 2 items", r.body?.cart?.items?.length === 2);
    check("customer1's Cart Bread is still 1 (not customer2's 7)", findItem(r.body, "Cart Bread")?.quantity === 1);

    // ============ Cart: DELETE /api/cart/items/:listingId ============
    console.log("\nDELETE /api/cart/items/:listingId");

    r = await req("DELETE", `/api/cart/items/${cartListingA.id}`);
    check("no token → 401", r.status === 401);

    r = await req("DELETE", "/api/cart/items/abc", { token: customerToken });
    check("invalid listing id → 400", r.status === 400 && r.body.error === "Invalid listing id");

    // Remove Cart Milk → only Cart Bread remains.
    r = await req("DELETE", `/api/cart/items/${cartListingA.id}`, { token: customerToken });
    check("remove one item → 200", r.status === 200);
    check("Cart Milk gone, Cart Bread remains (1 item)", r.body?.cart?.items?.length === 1 && !!findItem(r.body, "Cart Bread"));

    // Remove the same item again → idempotent, still 200, unchanged.
    r = await req("DELETE", `/api/cart/items/${cartListingA.id}`, { token: customerToken });
    check("removing an item that's already gone → 200 (idempotent)", r.status === 200 && r.body?.cart?.items?.length === 1);

    // ================= Cart: DELETE /api/cart =================
    console.log("\nDELETE /api/cart (clear)");

    r = await req("DELETE", "/api/cart");
    check("no token → 401", r.status === 401);

    r = await req("DELETE", "/api/cart", { token: customerToken });
    check("clear cart → 200 with empty items", r.status === 200 && Array.isArray(r.body?.cart?.items) && r.body.cart.items.length === 0);

    r = await req("GET", "/api/cart", { token: customerToken });
    check("GET after clear → still empty", r.body?.cart?.items?.length === 0);

    // Clearing customer1's cart left customer2's cart untouched.
    r = await req("GET", "/api/cart", { token: customer2Token });
    check("customer2's cart is unaffected by customer1 clearing", r.body?.cart?.items?.length === 1 && findItem(r.body, "Cart Bread")?.quantity === 7);
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
