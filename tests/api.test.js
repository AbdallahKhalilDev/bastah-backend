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
// Login and register really sign tokens, and signing fails without an expiry.
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
// Small rate limits, so the rate-limit tests can reach them in a few requests.
// (Every other request gets its own made-up IP address in req() below, so the
// rest of the suite never comes near these limits.)
process.env.LOGIN_MAX_FAILED_ATTEMPTS = "3";
process.env.AUTH_MAX_REQUESTS = "12";

const path = require("path");
const { execFile } = require("child_process");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const app = require("../app");
const { missingEnv } = require("../config/env");
const errorHandler = require("../middleware/errorHandler");

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

// Every request pretends to come from a DIFFERENT computer, by sending a made-up
// IP in X-Forwarded-For (the header Render's proxy sets; the app trusts one
// proxy, see "trust proxy" in app.js). So the hundreds of logins and sign-ups
// in this file never add up on one rate-limit counter. A test that WANTS
// requests to share a counter passes the same `ip` each time.
let fakeIpCounter = 0;
function nextFakeIp() {
  fakeIpCounter++;
  return `10.${(fakeIpCounter >> 16) & 255}.${(fakeIpCounter >> 8) & 255}.${fakeIpCounter & 255}`;
}

async function req(method, path, { token, body, ip } = {}) {
  const headers = { "X-Forwarded-For": ip || nextFakeIp() };
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
  return { status: res.status, body: json, headers: res.headers };
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
  const Order = require("../models/Order");
  const Area = require("../models/Area");
  await Promise.all([
    Listing.init(),
    Product.init(),
    Shop.init(),
    Review.init(),
    Cart.init(),
    Order.init(),
    Area.init(),
    // The unique email index must exist before the "two sign-ups at the same
    // moment" test, or the database couldn't refuse the second one.
    User.init(),
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
    let r;

    // ================= Auth: startup settings check =================
    console.log("\nRequired environment variables (config/env.js)");
    check(
      "nothing set → all three are reported missing",
      missingEnv({}).join(",") === "MONGO_URI,JWT_SECRET,JWT_EXPIRES_IN"
    );
    check(
      "an empty or blank value counts as missing",
      missingEnv({ MONGO_URI: "x", JWT_SECRET: "  ", JWT_EXPIRES_IN: "" }).join(",") ===
        "JWT_SECRET,JWT_EXPIRES_IN"
    );
    check(
      "all three set → nothing missing",
      missingEnv({ MONGO_URI: "x", JWT_SECRET: "y", JWT_EXPIRES_IN: "7d" }).length === 0
    );

    // ================= Auth: POST /api/auth/register =================
    console.log("\nPOST /api/auth/register");
    const signup = {
      name: "  New Customer  ",
      email: "  New.Customer@Test.com ",
      password: "secret123",
      phone: " 0599000000 ",
    };

    r = await req("POST", "/api/auth/register", { body: { ...signup, role: "admin" } });
    check("valid sign-up → 201", r.status === 201);
    check("...returns a token, so the new user is logged in at once", typeof r.body.token === "string");
    check("...returns the user", r.body.user && r.body.user.id);
    check("...as a customer, even though the body said role: admin", r.body.user.role === "customer");
    check("...name and phone trimmed", r.body.user.name === "New Customer" && r.body.user.phone === "0599000000");
    check("...email trimmed and lowercased", r.body.user.email === "new.customer@test.com");
    check("...never exposes passwordHash", !("passwordHash" in r.body.user));
    const signupToken = r.body.token;

    r = await req("GET", "/api/auth/me", { token: signupToken });
    check("the sign-up token works on /me → 200", r.status === 200);
    check("...and belongs to the new user", r.body.user.email === "new.customer@test.com");

    r = await req("POST", "/api/auth/register", {
      body: { ...signup, email: "NEW.CUSTOMER@test.com" },
    });
    check("same email in different capitals → 409", r.status === 409);
    check("...'Email already registered'", r.body.error === "Email already registered");

    // Five sign-ups with ONE email, all sent at the same moment. Several pass the
    // "is this email taken?" check before any is saved; the database's unique
    // index refuses the rest. Exactly one must win, and the others must get a
    // clean 409, never a 500.
    const raceBodies = Array.from({ length: 5 }, () => ({
      ...signup,
      email: "race@test.com",
    }));
    const race = await Promise.all(
      raceBodies.map((body) => req("POST", "/api/auth/register", { body }))
    );
    const raceStatuses = race.map((x) => x.status);
    check("5 simultaneous sign-ups, one email → exactly one 201", raceStatuses.filter((s) => s === 201).length === 1);
    check("...the other four → 409", raceStatuses.filter((s) => s === 409).length === 4);
    check(
      "...each 409 says 'Email already registered'",
      race.filter((x) => x.status === 409).every((x) => x.body.error === "Email already registered")
    );

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "short@test.com", password: "12345" } });
    check("password under 6 characters → 400", r.status === 400);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "long1@test.com", password: "a".repeat(73) } });
    check("password of 73 English letters (73 bytes) → 400", r.status === 400);
    check("...says it's too long", /too long/.test(r.body.error));

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "long2@test.com", password: "a".repeat(72) } });
    check("password of exactly 72 English letters → 201", r.status === 201);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "arabic1@test.com", password: "ب".repeat(37) } });
    check("password of 37 Arabic letters (74 bytes) → 400", r.status === 400);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "arabic2@test.com", password: "ب".repeat(36) } });
    check("password of 36 Arabic letters (72 bytes) → 201", r.status === 201);

    r = await req("POST", "/api/auth/login", { body: { email: "arabic2@test.com", password: "ب".repeat(36) } });
    check("...and that Arabic password logs in → 200", r.status === 200);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "name@test.com", name: "x".repeat(101) } });
    check("name over 100 characters → 400", r.status === 400);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "blank@test.com", name: "    " } });
    check("name of only spaces → 400 'Name is required'", r.status === 400 && r.body.error === "Name is required");

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "phone@test.com", phone: "1".repeat(21) } });
    check("phone over 20 characters → 400", r.status === 400);

    r = await req("POST", "/api/auth/register", { body: { ...signup, email: "x".repeat(250) + "@t.co" } });
    check("email over 254 characters → 400 'Email is too long'", r.status === 400 && r.body.error === "Email is too long");

    r = await req("POST", "/api/auth/register", { body: { name: "No Phone", email: "nophone@test.com", password: "secret123" } });
    check("missing phone → 400", r.status === 400);

    // ================= Auth: POST /api/auth/login =================
    console.log("\nPOST /api/auth/login");
    r = await req("POST", "/api/auth/login", {
      body: { email: "  NEW.customer@test.com ", password: "secret123" },
    });
    check("right password (email in any capitals, with spaces) → 200", r.status === 200);
    check("...returns a token", typeof r.body.token === "string");
    check("...returns the user with their role", r.body.user && r.body.user.role === "customer");
    check("...never exposes passwordHash", !("passwordHash" in r.body.user));
    const loginToken = r.body.token;

    r = await req("GET", "/api/auth/me", { token: loginToken });
    check("the login token works on /me → 200", r.status === 200);

    const wrongPassword = await req("POST", "/api/auth/login", {
      body: { email: "new.customer@test.com", password: "wrong-password" },
    });
    const unknownEmail = await req("POST", "/api/auth/login", {
      body: { email: "nobody@test.com", password: "secret123" },
    });
    check("wrong password → 401", wrongPassword.status === 401);
    check("unknown email → 401", unknownEmail.status === 401);
    check(
      "...both give the SAME message, so nobody can test which emails exist",
      wrongPassword.body.error === "Invalid email or password" &&
        unknownEmail.body.error === wrongPassword.body.error
    );

    r = await req("POST", "/api/auth/login", { body: { email: "new.customer@test.com" } });
    check("missing password → 400", r.status === 400);

    r = await req("POST", "/api/auth/login", { body: { email: "not-an-email", password: "secret123" } });
    check("malformed email → 400", r.status === 400);

    // ================= Auth: GET /api/auth/me =================
    console.log("\nGET /api/auth/me");
    r = await req("GET", "/api/auth/me");
    check("no token → 401", r.status === 401);

    r = await req("GET", "/api/auth/me", { token: "not-a-real-token" });
    check("garbage token → 401", r.status === 401);

    // ================= Auth: one login page per role =================
    console.log("\nLogin per role (/login, /seller/login, /admin/login)");
    // The seeded seller/admin at the top have a fake password hash ("x"), so
    // they can't log in. These two get a REAL bcrypt hash of "secret123".
    const realHash = await bcrypt.hash("secret123", 10);
    await User.create({
      name: "Portal Seller",
      email: "portal.seller@test.com",
      phone: "0599111111",
      passwordHash: realHash,
      role: "seller",
    });
    await User.create({
      name: "Portal Admin",
      email: "portal.admin@test.com",
      phone: "0599222222",
      passwordHash: realHash,
      role: "admin",
    });

    // Every account tries every login page: 3 accounts × 3 pages. Its own page
    // lets it in; the other two refuse it.
    const portals = [
      { path: "/api/auth/login", role: "customer", email: "new.customer@test.com", wrongMsg: "This is not a customer account" },
      { path: "/api/auth/seller/login", role: "seller", email: "portal.seller@test.com", wrongMsg: "This is not a seller account" },
      { path: "/api/auth/admin/login", role: "admin", email: "portal.admin@test.com", wrongMsg: "This is not an admin account" },
    ];
    const portalTokens = {};
    for (const page of portals) {
      for (const account of portals) {
        r = await req("POST", page.path, {
          body: { email: account.email, password: "secret123" },
        });
        if (page.role === account.role) {
          check(
            `${account.role} on ${page.path} → 200 with a token and role ${account.role}`,
            r.status === 200 && typeof r.body.token === "string" && r.body.user.role === account.role
          );
          portalTokens[account.role] = r.body.token;
        } else {
          check(`${account.role} on ${page.path} → 403 '${page.wrongMsg}'`, r.status === 403 && r.body.error === page.wrongMsg);
          check("...with code 'wrong_portal' and no token", r.body.code === "wrong_portal" && !("token" in r.body));
        }
      }
    }

    // The tokens from the new pages are real, working tokens.
    r = await req("GET", "/api/auth/me", { token: portalTokens.seller });
    check("token from /seller/login works on /me (role seller)", r.status === 200 && r.body.user.role === "seller");
    r = await req("GET", "/api/orders/incoming", { token: portalTokens.seller });
    check("...and opens a seller-only route → 200", r.status === 200);
    r = await req("GET", "/api/orders/incoming", { token: portalTokens.admin });
    check("token from /admin/login opens an admin route → 200", r.status === 200);

    // The wrong-page message only appears after a CORRECT password. With a wrong
    // password, a stranger learns nothing about what kind of account it is.
    r = await req("POST", "/api/auth/login", {
      body: { email: "portal.seller@test.com", password: "wrong-password" },
    });
    check("seller email on the customer page with a WRONG password → 401, not 403", r.status === 401);
    check("...the usual 'Invalid email or password'", r.body.error === "Invalid email or password");
    check("...and no code (only the wrong-page error has one)", !("code" in r.body));

    r = await req("POST", "/api/auth/admin/login", {
      body: { email: "nobody@test.com", password: "secret123" },
    });
    check("unknown email on the admin page → 401", r.status === 401);

    r = await req("POST", "/api/auth/seller/login", { body: { email: "portal.seller@test.com" } });
    check("seller page, missing password → 400", r.status === 400);

    r = await req("POST", "/api/auth/admin/register", {
      body: { name: "Hacker", email: "hacker@test.com", password: "secret123", phone: "1" },
    });
    check("there is NO admin sign-up: POST /api/auth/admin/register → 404", r.status === 404);
    check("...and no admin account was created", !(await User.exists({ email: "hacker@test.com" })));

    // ================= Central error handler: the optional `code` =================
    // Called directly with a fake `res`, because there's no endpoint that can
    // make a database-down error on demand.
    console.log("\nError handler: which errors may carry a code");
    function fakeRes() {
      return {
        statusCode: null,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; },
      };
    }
    let fr = fakeRes();
    errorHandler({ status: 403, message: "Nope", code: "wrong_portal" }, {}, fr, () => {});
    check("our own error with a code → the code is sent", fr.statusCode === 403 && fr.body.code === "wrong_portal");

    fr = fakeRes();
    errorHandler({ status: 404, message: "Not found" }, {}, fr, () => {});
    check("our own error without a code → just { error }", Object.keys(fr.body).join() === "error");

    fr = fakeRes();
    const dbDown = new Error("connect ECONNREFUSED 127.0.0.1:27017");
    dbDown.code = "ECONNREFUSED";
    errorHandler(dbDown, {}, fr, () => {});
    check("a Node error with its own code (database down) → 500", fr.statusCode === 500);
    check("...and its internal code is NOT sent to the user", !("code" in fr.body));

    // ================= Seller sign-up, with the first shop =================
    console.log("\nPOST /api/auth/seller/register (seller + first shop)");
    const sellerSignup = {
      name: "  Ahmad Seller ",
      email: "ahmad.seller@test.com",
      password: "secret123",
      phone: "0599333333",
      shop: {
        name: "  Ahmad Market  ",
        area: "Rimal",
        address: "Omar Al-Mukhtar St.",
        description: "Fresh vegetables",
      },
    };
    // Every email this section signs up with, so we can tidy up at the end.
    const signupEmails = [
      "ahmad.seller@test.com",
      "own.phone@test.com",
      "no.shop@test.com",
      "unlucky@test.com",
    ];
    const noAccount = async (email) => !(await User.exists({ email }));

    // A sneaky body: it tries to pick the role, the shop's owner, a verified
    // badge, a perfect rating, and to start the shop hidden. All must be ignored.
    r = await req("POST", "/api/auth/seller/register", {
      body: {
        ...sellerSignup,
        role: "admin",
        shop: {
          ...sellerSignup.shop,
          owner: seller._id.toString(),
          isVerified: true,
          ratingAvg: 5,
          ratingCount: 99,
          isActive: false,
        },
      },
    });
    check("valid seller sign-up → 201", r.status === 201);
    check("...the account is a seller (role: admin in the body ignored)", r.body.user?.role === "seller");
    check("...with a token, so they're logged in at once", typeof r.body.token === "string");
    check("...never exposes passwordHash", r.body.user && !("passwordHash" in r.body.user));
    const newShop = r.body.shop || {};
    const newSellerToken = r.body.token;
    check("...returns the new shop, name trimmed", newShop.name === "Ahmad Market");
    check("...owned by the NEW seller (owner in the body ignored)", newShop.owner === r.body.user?.id);
    check(
      "...area, address and description saved",
      newShop.area === "Rimal" && newShop.address === "Omar Al-Mukhtar St." && newShop.description === "Fresh vegetables"
    );
    check("...no shop phone sent → the shop uses the seller's phone", newShop.phone === "0599333333");
    check("...active (isActive: false in the body ignored)", newShop.isActive === true);
    check(
      "...not verified, no rating (body values ignored)",
      newShop.isVerified === false && newShop.ratingAvg === 0 && newShop.ratingCount === 0
    );

    r = await req("GET", "/api/shops/" + newShop._id);
    check("the new shop is public right away (GET /api/shops/:id → 200)", r.status === 200);

    r = await req("POST", "/api/auth/seller/login", {
      body: { email: "ahmad.seller@test.com", password: "secret123" },
    });
    check("the new seller logs in on the seller page → 200", r.status === 200);
    r = await req("POST", "/api/auth/login", {
      body: { email: "ahmad.seller@test.com", password: "secret123" },
    });
    check("...and the customer page refuses them → 403 wrong_portal", r.status === 403 && r.body.code === "wrong_portal");

    r = await req("PATCH", "/api/shops/" + newShop._id, {
      token: newSellerToken,
      body: { description: "Fresh fruit too" },
    });
    check(
      "the sign-up token can edit the new shop (they own it) → 200",
      r.status === 200 && r.body.shop?.description === "Fresh fruit too"
    );

    r = await req("POST", "/api/auth/seller/register", {
      body: {
        ...sellerSignup,
        email: "own.phone@test.com",
        shop: { name: "Own Phone Shop", phone: "082000000", category: category._id.toString() },
      },
    });
    check("shop with its own phone → 201, and the shop keeps that phone", r.status === 201 && r.body.shop?.phone === "082000000");
    check("...the chosen category is saved", r.body.shop?.category === category._id.toString());

    // --- Anything wrong → 400/409, and NOTHING is saved ---
    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: undefined },
    });
    check("no shop at all → 400 'Shop details are required'", r.status === 400 && r.body.error === "Shop details are required");
    check("...and NO account was created", await noAccount("no.shop@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: { area: "Rimal" } },
    });
    check("shop without a name → 400 'Shop name is required'", r.status === 400 && r.body.error === "Shop name is required");
    check("...and NO account was created", await noAccount("no.shop@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: { name: "    " } },
    });
    check("shop name of only spaces → 400 'Shop name is required'", r.status === 400 && r.body.error === "Shop name is required");

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: { name: "X", description: "d".repeat(1001) } },
    });
    check("shop description over 1000 characters → 400", r.status === 400 && /Description is too long/.test(r.body.error));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: { name: "X", category: "abc" } },
    });
    check("malformed category id → 400 'Invalid category id'", r.status === 400 && r.body.error === "Invalid category id");
    check("...and NO account was created", await noAccount("no.shop@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", shop: { name: "X", category: FAKE_ID } },
    });
    check("category that doesn't exist → 400 'Category not found'", r.status === 400 && r.body.error === "Category not found");
    check("...and NO account was created", await noAccount("no.shop@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com", password: "123" },
    });
    check("account problem (password too short) → 400", r.status === 400);
    check("...and NO account was created", await noAccount("no.shop@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "new.customer@test.com", shop: { name: "Should Not Exist" } },
    });
    check("email already used (by a customer) → 409", r.status === 409 && r.body.error === "Email already registered");
    check("...and NO shop was created", !(await Shop.exists({ name: "Should Not Exist" })));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "no.shop@test.com" },
    });
    check("after all those failures, the same email signs up fine → 201", r.status === 201);

    // --- The safety net: the shop save fails AFTER the account was saved ---
    // We can't make the real database fail on cue, so for one request we swap
    // Shop.create for a function that always fails, then put the real one back.
    const realShopCreate = Shop.create;
    Shop.create = async () => {
      throw new Error("simulated database failure");
    };
    try {
      r = await req("POST", "/api/auth/seller/register", {
        body: { ...sellerSignup, email: "unlucky@test.com" },
      });
    } finally {
      Shop.create = realShopCreate;
    }
    check("shop save fails after the account was made → 500", r.status === 500);
    check("...and the account is removed again: never a seller without a shop", await noAccount("unlucky@test.com"));

    r = await req("POST", "/api/auth/seller/register", {
      body: { ...sellerSignup, email: "unlucky@test.com" },
    });
    check("...so the same person can simply try again → 201", r.status === 201);

    // --- The shared shop rules now also protect /api/shops ---
    console.log("\nShared shop rules on POST/PATCH /api/shops");
    r = await req("POST", "/api/shops", { token: sellerToken, body: { name: "   ", phone: "1" } });
    check("POST: shop name of only spaces → 400", r.status === 400 && r.body.error === "Shop name is required");

    r = await req("POST", "/api/shops", { token: sellerToken, body: { name: "Long", phone: "1", address: "a".repeat(201) } });
    check("POST: address over 200 characters → 400", r.status === 400 && /Address is too long/.test(r.body.error));

    r = await req("POST", "/api/shops", { token: sellerToken, body: { name: "No Phone" } });
    check("POST: missing phone → 400 'Shop phone is required'", r.status === 400 && r.body.error === "Shop phone is required");

    r = await req("PATCH", "/api/shops/" + shopA._id, { token: sellerToken, body: { category: "" } });
    check("PATCH: empty category → 400 'Invalid category id' (not a crash)", r.status === 400 && r.body.error === "Invalid category id");

    r = await req("PATCH", "/api/shops/" + shopA._id, { token: sellerToken, body: { name: "" } });
    check("PATCH: blanking the name → 400", r.status === 400);

    // Tidy up: remove the shops this section created, so the tests further down
    // see exactly the shops they expect.
    const signupIds = (await User.find({ email: { $in: signupEmails } }).select("_id")).map((u) => u._id);
    await Shop.deleteMany({ owner: { $in: signupIds } });

    // ================= Friendly messages for missing fields =================
    console.log("\nFriendly messages when a field is missing");
    r = await req("POST", "/api/auth/login", { body: {} });
    check("login with nothing → 400 'Email is required'", r.status === 400 && r.body.error === "Email is required");
    r = await req("POST", "/api/auth/login", { body: { email: "a@test.com" } });
    check("login without password → 400 'Password is required'", r.status === 400 && r.body.error === "Password is required");
    r = await req("POST", "/api/auth/register", { body: {} });
    check("sign-up with nothing → 400 'Name is required'", r.status === 400 && r.body.error === "Name is required");
    r = await req("POST", "/api/auth/register", { body: { name: "X" } });
    check("sign-up without email → 400 'Email is required'", r.status === 400 && r.body.error === "Email is required");

    // ================= My account: PATCH /api/auth/me =================
    console.log("\nPATCH /api/auth/me (edit my name and phone)");
    r = await req("POST", "/api/auth/register", {
      body: { name: "Me User", email: "me.user@test.com", password: "secret123", phone: "0599444444" },
    });
    const meToken = r.body.token;

    r = await req("PATCH", "/api/auth/me", {
      token: meToken,
      body: { name: "  Me Renamed  ", phone: " 0599555555 ", email: "hijack@test.com", role: "admin" },
    });
    check("change name and phone → 200", r.status === 200);
    check("...name trimmed and updated", r.body.user?.name === "Me Renamed");
    check("...phone trimmed and updated", r.body.user?.phone === "0599555555");
    check("...email NOT changed (not allowed here)", r.body.user?.email === "me.user@test.com");
    check("...role NOT changed", r.body.user?.role === "customer");

    r = await req("GET", "/api/auth/me", { token: meToken });
    check("GET /me shows the new name (it was really saved)", r.body.user?.name === "Me Renamed");

    r = await req("PATCH", "/api/auth/me", { token: meToken, body: { phone: "0599666666" } });
    check(
      "only phone sent → phone changes, name stays",
      r.status === 200 && r.body.user?.name === "Me Renamed" && r.body.user?.phone === "0599666666"
    );

    r = await req("PATCH", "/api/auth/me", { token: meToken, body: {} });
    check("empty body → 200, nothing changes", r.status === 200 && r.body.user?.name === "Me Renamed");

    r = await req("PATCH", "/api/auth/me", { token: meToken, body: { name: "   " } });
    check("blank name → 400 'Name is required'", r.status === 400 && r.body.error === "Name is required");

    r = await req("PATCH", "/api/auth/me", { token: meToken, body: { phone: "1".repeat(21) } });
    check("phone over 20 characters → 400", r.status === 400);

    r = await req("PATCH", "/api/auth/me", { body: { name: "X" } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", "/api/auth/me", { token: portalTokens.seller, body: { name: "Portal Seller Renamed" } });
    check("works for a seller too → 200", r.status === 200 && r.body.user?.name === "Portal Seller Renamed");
    r = await req("PATCH", "/api/auth/me", { token: portalTokens.admin, body: { phone: "0599888888" } });
    check("...and for an admin → 200", r.status === 200 && r.body.user?.phone === "0599888888");

    // ================= My account: PATCH /api/auth/me/password =================
    console.log("\nPATCH /api/auth/me/password (change my password)");
    // The same account is ALSO logged in on a second device, say a laptop.
    r = await req("POST", "/api/auth/login", { body: { email: "me.user@test.com", password: "secret123" } });
    const laptopToken = r.body.token;

    r = await req("PATCH", "/api/auth/me/password", {
      token: meToken,
      body: { currentPassword: "wrong-one", newPassword: "newsecret456" },
    });
    check(
      "wrong current password → 400 'Current password is incorrect' (not 401)",
      r.status === 400 && r.body.error === "Current password is incorrect"
    );
    r = await req("GET", "/api/auth/me", { token: meToken });
    check("...and the user is still logged in after the failed attempt", r.status === 200);

    r = await req("PATCH", "/api/auth/me/password", { token: meToken, body: { newPassword: "newsecret456" } });
    check("missing current password → 400 'Current password is required'", r.status === 400 && r.body.error === "Current password is required");

    r = await req("PATCH", "/api/auth/me/password", { token: meToken, body: { currentPassword: "secret123", newPassword: "123" } });
    check("new password under 6 characters → 400", r.status === 400 && r.body.error === "Password must be at least 6 characters");

    r = await req("PATCH", "/api/auth/me/password", { token: meToken, body: { currentPassword: "secret123", newPassword: "a".repeat(73) } });
    check("new password over 72 bytes → 400", r.status === 400 && /too long/.test(r.body.error));

    r = await req("PATCH", "/api/auth/me/password", { body: { currentPassword: "secret123", newPassword: "newsecret456" } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", "/api/auth/me/password", {
      token: meToken,
      body: { currentPassword: "secret123", newPassword: "newsecret456" },
    });
    check("right current password → 200", r.status === 200);
    check("...returns a fresh token", typeof r.body.token === "string" && r.body.token !== meToken);
    const freshToken = r.body.token;

    r = await req("GET", "/api/auth/me", { token: freshToken });
    check("the fresh token works → 200 (this device stays logged in)", r.status === 200);
    r = await req("GET", "/api/auth/me", { token: meToken });
    check("the OLD token of this device → 401", r.status === 401);
    check(
      "...'Your password was changed. Please log in again'",
      r.body.error === "Your password was changed. Please log in again"
    );
    r = await req("GET", "/api/auth/me", { token: laptopToken });
    check("the laptop's token → 401 too (logged out everywhere)", r.status === 401);

    r = await req("POST", "/api/auth/login", { body: { email: "me.user@test.com", password: "secret123" } });
    check("the old password no longer logs in → 401", r.status === 401);
    r = await req("POST", "/api/auth/login", { body: { email: "me.user@test.com", password: "newsecret456" } });
    check("the new password logs in → 200", r.status === 200);

    r = await req("PATCH", "/api/auth/me/password", {
      token: freshToken,
      body: { currentPassword: "newsecret456", newPassword: "third789" },
    });
    check("changing it a second time → 200", r.status === 200);
    const thirdToken = r.body.token;
    r = await req("GET", "/api/auth/me", { token: freshToken });
    check("...the token from the first change stops working too → 401", r.status === 401);
    r = await req("GET", "/api/auth/me", { token: thirdToken });
    check("...the newest token works → 200", r.status === 200);

    // ================= auth: the database is the truth, not the token =================
    console.log("\nauth middleware reads the account from the database");

    // Tokens made BEFORE this update carry no tokenVersion. They must keep
    // working, or every user of the live app would be logged out at deploy.
    // (tokenFor() makes exactly that kind of token.)
    r = await req("GET", "/api/auth/me", { token: tokenFor(customer) });
    check("a token made before this update (no counter inside) still works → 200", r.status === 200);

    // An account saved before tokenVersion existed has NOTHING stored for it.
    // insertOne goes straight to MongoDB, skipping Mongoose's defaults, exactly
    // like the accounts already in Atlas.
    await User.collection.insertOne({
      name: "Old Account",
      email: "old.account@test.com",
      phone: "0599000002",
      role: "customer",
      passwordHash: realHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    r = await req("POST", "/api/auth/login", { body: { email: "old.account@test.com", password: "secret123" } });
    check("an account from before this update logs in → 200", r.status === 200);
    const oldAccountToken = r.body.token;
    r = await req("GET", "/api/auth/me", { token: oldAccountToken });
    check("...its token works → 200", r.status === 200);
    r = await req("PATCH", "/api/auth/me/password", {
      token: oldAccountToken,
      body: { currentPassword: "secret123", newPassword: "newsecret456" },
    });
    check("...and it can change its password (the counter starts from 0) → 200", r.status === 200);
    r = await req("GET", "/api/auth/me", { token: r.body.token });
    check("...with a working fresh token → 200", r.status === 200);

    // The account is deleted while its token is still valid.
    const doomed = await User.create({ name: "Doomed", email: "doomed@test.com", passwordHash: "x", role: "customer" });
    const doomedToken = tokenFor(doomed);
    r = await req("GET", "/api/auth/me", { token: doomedToken });
    check("token works while the account exists → 200", r.status === 200);
    await User.deleteOne({ _id: doomed._id });
    r = await req("GET", "/api/auth/me", { token: doomedToken });
    check("...account deleted → the same token gets 401", r.status === 401);

    // The role is read from the database, so a change counts at once.
    const promoted = await User.create({ name: "Promoted", email: "promoted@test.com", passwordHash: "x", role: "customer" });
    const promotedToken = tokenFor(promoted); // the token says "customer"
    r = await req("GET", "/api/orders/incoming", { token: promotedToken });
    check("a customer on a seller-only route → 403", r.status === 403);
    await User.updateOne({ _id: promoted._id }, { role: "seller" });
    r = await req("GET", "/api/orders/incoming", { token: promotedToken });
    check("...role changed to seller in the database → the SAME token now gets 200", r.status === 200);

    // A token that claims a role the account doesn't have. (Only someone with
    // our secret could make one, but it shows the database wins.)
    const liarToken = jwt.sign({ id: customer._id, role: "admin" }, process.env.JWT_SECRET);
    r = await req("GET", "/api/orders/incoming", { token: liarToken });
    check("a token saying 'admin' for a customer account → 403 (the database wins)", r.status === 403);

    // ================= Admin: the whole /api/admin area is guarded =================
    console.log("\n/api/admin: admins only (router-level guard)");
    const adminRoutes = [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/users/" + customer._id],
      ["POST", "/api/admin/users"],
    ];
    for (const [method, url] of adminRoutes) {
      r = await req(method, url, { body: method === "POST" ? {} : undefined });
      check(`${method} ${url.replace(String(customer._id), ":id")}, no token → 401`, r.status === 401);
      r = await req(method, url, { token: customerToken, body: method === "POST" ? {} : undefined });
      check("...customer → 403", r.status === 403);
      r = await req(method, url, { token: sellerToken, body: method === "POST" ? {} : undefined });
      check("...seller → 403", r.status === 403);
    }
    r = await req("GET", "/api/admin/does-not-exist", { token: customerToken });
    check("a made-up admin path, as a customer → 403 (outsiders can't map the admin area)", r.status === 403);
    r = await req("GET", "/api/admin/does-not-exist", { token: adminToken });
    check("...the same path as an admin → 404", r.status === 404);

    // ================= Admin: GET /api/admin/users =================
    console.log("\nGET /api/admin/users (list, filter, search)");
    r = await req("GET", "/api/admin/users", { token: adminToken });
    check("admin → 200 with users, page, limit, total", r.status === 200 && Array.isArray(r.body.users) && r.body.page === 1);
    check("...total = every account in the database", r.body.total === (await User.countDocuments()));
    check("...no passwordHash anywhere", r.body.users.every((u) => !("passwordHash" in u)));
    check(
      "...newest first",
      r.body.users.every((u, i, all) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(u.createdAt))
    );

    r = await req("GET", "/api/admin/users?role=seller", { token: adminToken });
    check("?role=seller → only sellers", r.status === 200 && r.body.users.every((u) => u.role === "seller"));
    check("...total = number of sellers", r.body.total === (await User.countDocuments({ role: "seller" })));

    r = await req("GET", "/api/admin/users?role=superuser", { token: adminToken });
    check("?role=superuser → 400 'Invalid role'", r.status === 400 && r.body.error === "Invalid role");

    r = await req("GET", "/api/admin/users?q=PORTAL", { token: adminToken });
    const portalEmails = (r.body.users || []).map((u) => u.email).sort().join(",");
    check(
      "?q=PORTAL → finds the portal seller and admin (any capitals)",
      portalEmails === "portal.admin@test.com,portal.seller@test.com"
    );

    r = await req("GET", "/api/admin/users?q=0599111111", { token: adminToken });
    check("?q=<phone number> → finds that account by phone", r.body.users?.length === 1 && r.body.users[0].email === "portal.seller@test.com");

    r = await req("GET", "/api/admin/users?q=portal&role=admin", { token: adminToken });
    check("?q + ?role together → only the portal admin", r.body.total === 1 && r.body.users[0].role === "admin");

    r = await req("GET", "/api/admin/users?q=" + encodeURIComponent("("), { token: adminToken });
    check("?q=( does not crash (search text is escaped) → 200", r.status === 200);

    r = await req("GET", "/api/admin/users?limit=2&page=2", { token: adminToken });
    check("?limit=2&page=2 → the second page of 2", r.status === 200 && r.body.page === 2 && r.body.limit === 2 && r.body.users.length === 2);

    // ================= Admin: GET /api/admin/users/:id =================
    console.log("\nGET /api/admin/users/:id");
    r = await req("GET", "/api/admin/users/not-an-id", { token: adminToken });
    check("malformed id → 400 'Invalid user id'", r.status === 400 && r.body.error === "Invalid user id");
    r = await req("GET", "/api/admin/users/" + FAKE_ID, { token: adminToken });
    check("unknown id → 404 'User not found'", r.status === 404 && r.body.error === "User not found");

    r = await req("GET", "/api/admin/users/" + customer._id, { token: adminToken });
    check("a customer → 200 with the user and an empty shops list", r.status === 200 && r.body.user?.email === "customer@test.com" && r.body.shops?.length === 0);
    check("...no passwordHash", !("passwordHash" in r.body.user));

    r = await req("GET", "/api/admin/users/" + seller._id, { token: adminToken });
    check(
      "a seller → ALL their shops",
      r.status === 200 && r.body.shops?.length === (await Shop.countDocuments({ owner: seller._id }))
    );
    check("...including the hidden one the public can't see", r.body.shops.some((s) => s.name === "Hidden Shop" && s.isActive === false));

    // ================= Admin: POST /api/admin/users =================
    console.log("\nPOST /api/admin/users (admin creates accounts)");
    const adminMade = { name: "Made By Admin", password: "secret123", phone: "0599121212" };

    r = await req("POST", "/api/admin/users", {
      token: adminToken,
      body: { ...adminMade, email: "made.customer@test.com", role: "customer", shop: { name: "Ignored Shop" } },
    });
    check("create a customer → 201", r.status === 201 && r.body.user?.role === "customer");
    check("...no token in the reply (the admin stays logged in as themselves)", !("token" in r.body));
    check("...a shop sent for a customer is ignored", r.body.shop === null && !(await Shop.exists({ name: "Ignored Shop" })));
    r = await req("POST", "/api/auth/login", { body: { email: "made.customer@test.com", password: "secret123" } });
    check("...the new customer logs in on the customer page → 200", r.status === 200);

    r = await req("POST", "/api/admin/users", {
      token: adminToken,
      body: { ...adminMade, email: "made.admin@test.com", role: "admin" },
    });
    check("create an admin → 201", r.status === 201 && r.body.user?.role === "admin");
    r = await req("POST", "/api/auth/admin/login", { body: { email: "made.admin@test.com", password: "secret123" } });
    check("...the new admin logs in on the admin page → 200", r.status === 200);
    r = await req("GET", "/api/admin/users", { token: r.body.token });
    check("...and can use the admin area at once → 200", r.status === 200);

    r = await req("POST", "/api/admin/users", {
      token: adminToken,
      body: { ...adminMade, email: "made.seller@test.com", role: "seller", shop: { name: "Admin Made Market", area: "Rimal" } },
    });
    check("create a seller with a shop → 201", r.status === 201 && r.body.user?.role === "seller");
    check("...the shop is owned by the NEW seller, not the admin", r.body.shop?.owner === r.body.user?.id);
    check("...shop phone left out → the seller's phone", r.body.shop?.phone === "0599121212");
    r = await req("POST", "/api/auth/seller/login", { body: { email: "made.seller@test.com", password: "secret123" } });
    check("...the new seller logs in on the seller page → 200", r.status === 200);

    r = await req("POST", "/api/admin/users", {
      token: adminToken,
      body: { ...adminMade, email: "shopless.seller@test.com", role: "seller" },
    });
    check("a seller WITHOUT a shop → 400 'Shop details are required'", r.status === 400 && r.body.error === "Shop details are required");
    check("...and no account was created", !(await User.exists({ email: "shopless.seller@test.com" })));

    r = await req("POST", "/api/admin/users", { token: adminToken, body: { ...adminMade, email: "norole@test.com" } });
    check("no role → 400 'Role must be customer, seller or admin'", r.status === 400 && r.body.error === "Role must be customer, seller or admin");
    r = await req("POST", "/api/admin/users", { token: adminToken, body: { ...adminMade, email: "norole@test.com", role: "superuser" } });
    check("an unknown role → 400", r.status === 400);

    r = await req("POST", "/api/admin/users", { token: adminToken, body: { ...adminMade, email: "made.customer@test.com", role: "customer" } });
    check("an email already in use → 409", r.status === 409 && r.body.error === "Email already registered");

    r = await req("POST", "/api/admin/users", { token: adminToken, body: { ...adminMade, email: "weak@test.com", role: "customer", password: "123" } });
    check("a password under 6 characters → 400 (same rules as sign-up)", r.status === 400);

    // Tidy up the shop this section created, so later tests see the shops they expect.
    await Shop.deleteMany({ name: "Admin Made Market" });

    // ================= The create-admin script =================
    // It runs as a SEPARATE program, exactly like `npm run create-admin`, against
    // the same test database (it inherits our MONGO_URI).
    console.log("\nnpm run create-admin (the script)");
    const runCreateAdmin = (args) =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(__dirname, "..", "scripts", "createAdmin.js"), ...args],
          { env: process.env },
          (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
        );
      });

    let run = await runCreateAdmin(["first.admin@test.com", "First Admin", "0599999999"]);
    check("creates an admin → exits OK", run.code === 0);
    check("...says which database it wrote to", run.stdout.includes('"bastah_test"'));
    const printedPassword = (run.stdout.match(/Password:\s*(\S+)/) || [])[1];
    check("...prints a password", typeof printedPassword === "string" && printedPassword.length >= 16);
    r = await req("POST", "/api/auth/admin/login", { body: { email: "first.admin@test.com", password: printedPassword } });
    check("...and that password logs in on the admin page → 200", r.status === 200 && r.body.user?.role === "admin");

    run = await runCreateAdmin(["first.admin@test.com", "First Admin", "0599999999"]);
    check("same email again → refuses (exit code 1)", run.code === 1 && run.stderr.includes("already exists"));

    run = await runCreateAdmin(["customer@test.com", "Sneaky", "0599999999"]);
    check("an existing CUSTOMER's email → refuses", run.code === 1);
    check("...and that customer is still a customer", (await User.findById(customer._id)).role === "customer");

    run = await runCreateAdmin(["only-an-email@test.com"]);
    check("missing name/phone → refuses with the usage line", run.code === 1 && run.stderr.includes("Usage"));

    run = await runCreateAdmin(["not-an-email", "Bad Email", "0599999999"]);
    check("an invalid email → refuses (same rules as sign-up)", run.code === 1 && run.stderr.includes("A valid email is required"));

    // ================= Admin: PATCH /api/admin/users/:id (edit details) =================
    console.log("\nPATCH /api/admin/users/:id (admin edits name, email, phone)");
    r = await req("POST", "/api/auth/register", {
      body: { name: "Target User", email: "target@test.com", password: "secret123", phone: "0599131313" },
    });
    const targetId = r.body.user.id;
    let targetToken = r.body.token;
    const madeAdmin = await User.findOne({ email: "made.admin@test.com" });
    const portalSeller = await User.findOne({ email: "portal.seller@test.com" });

    // The three new routes sit inside the guarded admin area too.
    for (const [suffix, body] of [
      ["", { name: "X" }],
      ["/password", { newPassword: "hacked123" }],
      ["/status", { status: "suspended", reason: "x" }],
    ]) {
      r = await req("PATCH", `/api/admin/users/${targetId}${suffix}`, { token: customerToken, body });
      check(`PATCH /api/admin/users/:id${suffix} as a customer → 403`, r.status === 403);
    }

    r = await req("PATCH", "/api/admin/users/" + targetId, {
      token: adminToken,
      body: {
        name: "  Target Renamed ",
        email: " NEW.Target@test.com ",
        phone: "0599141414",
        role: "admin",
        status: "suspended",
        password: "hacked123",
      },
    });
    check("admin edits name, email and phone → 200", r.status === 200);
    check(
      "...all three changed (trimmed, email lowercased)",
      r.body.user?.name === "Target Renamed" && r.body.user?.email === "new.target@test.com" && r.body.user?.phone === "0599141414"
    );
    check(
      "...role, status and password in the body are ignored",
      r.body.user?.role === "customer" && r.body.user?.status === "active"
    );

    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "secret123" } });
    check("the user now logs in with the NEW email (same password) → 200", r.status === 200);
    r = await req("POST", "/api/auth/login", { body: { email: "target@test.com", password: "secret123" } });
    check("...the old email no longer works → 401", r.status === 401);
    r = await req("GET", "/api/auth/me", { token: targetToken });
    check("...and the email change did NOT log them out → 200", r.status === 200);

    r = await req("PATCH", "/api/admin/users/" + targetId, { token: adminToken, body: { email: "customer@test.com" } });
    check("an email that belongs to ANOTHER account → 409", r.status === 409 && r.body.error === "Email already registered");
    r = await req("PATCH", "/api/admin/users/" + targetId, { token: adminToken, body: { email: "NEW.TARGET@test.com" } });
    check("re-sending the account's OWN email (other capitals) → 200, not a clash", r.status === 200);
    r = await req("PATCH", "/api/admin/users/" + targetId, { token: adminToken, body: { email: "not-an-email" } });
    check("an invalid email → 400", r.status === 400);
    r = await req("PATCH", "/api/admin/users/" + targetId, { token: adminToken, body: { name: "   " } });
    check("a blank name → 400 'Name is required'", r.status === 400 && r.body.error === "Name is required");
    r = await req("PATCH", "/api/admin/users/not-an-id", { token: adminToken, body: { name: "X" } });
    check("malformed id → 400", r.status === 400 && r.body.error === "Invalid user id");
    r = await req("PATCH", "/api/admin/users/" + FAKE_ID, { token: adminToken, body: { name: "X" } });
    check("unknown id → 404", r.status === 404);
    r = await req("PATCH", "/api/admin/users/" + madeAdmin._id, { token: adminToken, body: { name: "Renamed Admin" } });
    check("an admin can edit ANOTHER admin → 200", r.status === 200 && r.body.user?.name === "Renamed Admin");

    // ================= Admin: PATCH /api/admin/users/:id/password =================
    console.log("\nPATCH /api/admin/users/:id/password (admin sets a new password)");
    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "secret123" } });
    const targetSecondDevice = r.body.token;

    r = await req("PATCH", `/api/admin/users/${targetId}/password`, { token: adminToken, body: { newPassword: "temp4567" } });
    check("admin sets a new password → 200", r.status === 200);
    check("...no token in the reply (it would be the user's, not the admin's)", !("token" in r.body));
    r = await req("GET", "/api/auth/me", { token: targetToken });
    check("...the user's old token → 401 (logged out everywhere)", r.status === 401);
    r = await req("GET", "/api/auth/me", { token: targetSecondDevice });
    check("...their second device too → 401", r.status === 401);
    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "secret123" } });
    check("...the old password → 401", r.status === 401);
    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "temp4567" } });
    check("...the new password → 200", r.status === 200);
    targetToken = r.body.token;

    r = await req("PATCH", `/api/admin/users/${targetId}/password`, { token: adminToken, body: { newPassword: "123" } });
    check("a password under 6 characters → 400", r.status === 400);
    r = await req("PATCH", `/api/admin/users/${targetId}/password`, { token: adminToken, body: {} });
    check("no password → 400 'Password is required'", r.status === 400 && r.body.error === "Password is required");

    r = await req("PATCH", `/api/admin/users/${admin._id}/password`, { token: adminToken, body: { newPassword: "mine12345" } });
    check(
      "an admin setting their OWN password here → 403",
      r.status === 403 && r.body.error === "Change your own password from your account settings"
    );

    r = await req("PATCH", `/api/admin/users/${madeAdmin._id}/password`, { token: adminToken, body: { newPassword: "admin2pass" } });
    check("setting ANOTHER admin's password → 200", r.status === 200);
    r = await req("POST", "/api/auth/admin/login", { body: { email: "made.admin@test.com", password: "admin2pass" } });
    check("...that admin logs in with it → 200", r.status === 200);
    const madeAdminToken = r.body.token;

    // ================= Admin: PATCH /api/admin/users/:id/status =================
    console.log("\nPATCH /api/admin/users/:id/status (suspend / switch back on)");
    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "suspended" } });
    check("suspend without a reason → 400", r.status === 400 && r.body.error === "A reason is required to suspend an account");
    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "suspended", reason: "   " } });
    check("...a reason of only spaces counts as none → 400", r.status === 400);
    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "banned", reason: "x" } });
    check("an unknown status → 400 'Status must be active or suspended'", r.status === 400 && r.body.error === "Status must be active or suspended");
    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "active" } });
    check("switching ON an account that is already on → 409", r.status === 409 && r.body.error === "Account is already active");

    r = await req("PATCH", `/api/admin/users/${targetId}/status`, {
      token: adminToken,
      body: { status: "suspended", reason: "Posting fake reviews" },
    });
    check("suspend with a reason → 200", r.status === 200 && r.body.user?.status === "suspended");
    check("...the reason is saved", r.body.user?.statusReason === "Posting fake reviews");
    check(
      "...with WHEN and WHICH admin",
      typeof r.body.user?.statusChangedAt === "string" && r.body.user?.statusChangedBy === admin._id.toString()
    );

    r = await req("GET", "/api/auth/me", { token: targetToken });
    check("the suspended user's EXISTING token → 403", r.status === 403);
    check("...code 'account_suspended'", r.body.code === "account_suspended");
    check("...and the message shows the reason", r.body.error === "This account is suspended: Posting fake reviews");
    r = await req("GET", "/api/cart", { token: targetToken });
    check("...on every route, not only /me (the cart) → 403", r.status === 403 && r.body.code === "account_suspended");

    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "temp4567" } });
    check("logging in, right password → 403 'account_suspended'", r.status === 403 && r.body.code === "account_suspended");
    check("...with the reason and no token", r.body.error === "This account is suspended: Posting fake reviews" && !("token" in r.body));
    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "wrong-one" } });
    check("logging in, WRONG password → the usual 401 (a stranger learns nothing)", r.status === 401 && !("code" in r.body));

    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "suspended", reason: "again" } });
    check("suspending it again → 409 'Account is already suspended'", r.status === 409 && r.body.error === "Account is already suspended");

    r = await req("GET", "/api/admin/users/" + targetId, { token: adminToken });
    check("the admin's user details show the status and the reason", r.body.user?.status === "suspended" && r.body.user?.statusReason === "Posting fake reviews");

    // ?status= on the admin list. An account saved before `status` existed has
    // NOTHING stored; it must still count as active.
    await User.collection.insertOne({
      name: "No Status Stored",
      email: "nostatus@test.com",
      phone: "0599000003",
      role: "customer",
      passwordHash: realHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    check(
      "(setup) the old-style account really has no status stored",
      (await User.collection.findOne({ email: "nostatus@test.com" })).status === undefined
    );
    r = await req("GET", "/api/admin/users?status=suspended", { token: adminToken });
    check(
      "?status=suspended → only suspended accounts, including ours",
      r.status === 200 && r.body.users.every((u) => u.status === "suspended") && r.body.users.some((u) => u.id === targetId)
    );
    r = await req("GET", "/api/admin/users?status=active&q=nostatus", { token: adminToken });
    check("?status=active also finds an account with NO status stored", r.body.total === 1 && r.body.users[0].status === "active");
    r = await req("GET", "/api/admin/users?status=active", { token: adminToken });
    check("?status=active never lists a suspended account", r.body.users.every((u) => u.status === "active"));
    r = await req("GET", "/api/admin/users?status=banned", { token: adminToken });
    check("?status=banned → 400 'Invalid status'", r.status === 400 && r.body.error === "Invalid status");

    r = await req("PATCH", `/api/admin/users/${targetId}/status`, { token: adminToken, body: { status: "active" } });
    check("switch the account back on → 200", r.status === 200 && r.body.user?.status === "active");
    check("...the reason is cleared", r.body.user?.statusReason === null);
    r = await req("GET", "/api/auth/me", { token: targetToken });
    check("...their SAME token works again (suspending paused the account)", r.status === 200);
    r = await req("POST", "/api/auth/login", { body: { email: "new.target@test.com", password: "temp4567" } });
    check("...and they can log in again → 200", r.status === 200);

    r = await req("PATCH", `/api/admin/users/${admin._id}/status`, { token: adminToken, body: { status: "suspended", reason: "x" } });
    check("an admin suspending THEMSELVES → 403", r.status === 403 && r.body.error === "You can't change your own status");

    // Sellers and other admins can be suspended too.
    r = await req("PATCH", `/api/admin/users/${portalSeller._id}/status`, {
      token: adminToken,
      body: { status: "suspended", reason: "Fake prices" },
    });
    check("suspend a SELLER → 200", r.status === 200);
    r = await req("GET", "/api/orders/incoming", { token: portalTokens.seller });
    check("...their seller pages are refused → 403 account_suspended", r.status === 403 && r.body.code === "account_suspended");
    r = await req("PATCH", `/api/admin/users/${portalSeller._id}/status`, { token: adminToken, body: { status: "active" } });
    r = await req("GET", "/api/orders/incoming", { token: portalTokens.seller });
    check("...switched back on → 200 again", r.status === 200);

    r = await req("PATCH", `/api/admin/users/${madeAdmin._id}/status`, {
      token: adminToken,
      body: { status: "suspended", reason: "Left the team" },
    });
    check("suspend ANOTHER admin → 200", r.status === 200);
    r = await req("GET", "/api/admin/users", { token: madeAdminToken });
    check("...they're locked out of the admin area → 403 account_suspended", r.status === 403 && r.body.code === "account_suspended");
    r = await req("PATCH", `/api/admin/users/${madeAdmin._id}/status`, { token: adminToken, body: { status: "active" } });
    check("...switched back on → 200", r.status === 200);

    const noStatus = await User.findOne({ email: "nostatus@test.com" });
    r = await req("PATCH", `/api/admin/users/${noStatus._id}/status`, {
      token: adminToken,
      body: { status: "suspended", reason: "Spam" },
    });
    check("an account with NO status stored can be suspended (it counts as active) → 200", r.status === 200);

    // ================= Rate limiting (limits set small at the top: 3 and 12) =================
    console.log("\nRate limiting: failed logins per IP + email");
    for (const email of ["limit.user@test.com", "limit.other@test.com"]) {
      await req("POST", "/api/auth/register", {
        body: { name: "Limit Test", email, password: "secret123", phone: "0599151515" },
      });
    }
    const loginAt = (ip, email, password, page = "/api/auth/login") =>
      req("POST", page, { ip, body: { email, password } });

    // Scenario A: one computer guesses the password of ONE account.
    const ipA = "198.51.100.1";
    let fails = [];
    for (let i = 0; i < 3; i++) fails.push((await loginAt(ipA, "limit.user@test.com", "wrong-" + i)).status);
    check("3 wrong passwords → 401 each (still allowed)", fails.every((s) => s === 401));
    r = await loginAt(ipA, "limit.user@test.com", "wrong-4");
    check("the 4th wrong password → 429", r.status === 429);
    check("...code 'too_many_attempts' with a clear message", r.body.code === "too_many_attempts" && /wait 15 minutes/.test(r.body.error));
    check("...and a Retry-After header telling the app how long to wait", Number(r.headers.get("retry-after")) > 0);
    r = await loginAt(ipA, "limit.user@test.com", "secret123");
    check("while blocked, even the RIGHT password → 429 (no more guessing)", r.status === 429);

    r = await loginAt(ipA, "limit.other@test.com", "secret123");
    check("someone ELSE on the same IP (another email) logs in fine → 200", r.status === 200);
    r = await loginAt(ipA, "limit.other@test.com", "wrong-x");
    check("...and still gets normal 401s, not the other person's block", r.status === 401);
    r = await loginAt("198.51.100.2", "limit.user@test.com", "secret123");
    check("the blocked account from a DIFFERENT IP → 200 (the block is per IP + email)", r.status === 200);

    // Scenario B: the three login pages share one counter.
    const ipB = "198.51.100.3";
    await loginAt(ipB, "limit.other@test.com", "wrong-1", "/api/auth/login");
    await loginAt(ipB, "limit.other@test.com", "wrong-2", "/api/auth/seller/login");
    await loginAt(ipB, "limit.other@test.com", "wrong-3", "/api/auth/admin/login");
    r = await loginAt(ipB, "limit.other@test.com", "wrong-4", "/api/auth/login");
    check("1 wrong guess on each of the 3 login pages, then a 4th → 429 (switching pages gives no extra tries)", r.status === 429);

    // Scenario C: only WRONG PASSWORDS use up tries.
    const ipC = "198.51.100.4";
    let ok = [];
    for (let i = 0; i < 4; i++) ok.push((await loginAt(ipC, "limit.user@test.com", "secret123")).status);
    check("4 successful logins in a row → all 200 (successes don't count)", ok.every((s) => s === 200));
    r = await loginAt(ipC, "limit.user@test.com", "secret123", "/api/auth/seller/login");
    check("right password on the wrong page → 403, and it doesn't count", r.status === 403);
    r = await req("POST", "/api/auth/login", { ip: ipC, body: { email: "limit.user@test.com" } });
    check("a form mistake (no password) → 400, and it doesn't count", r.status === 400);
    fails = [];
    for (let i = 0; i < 3; i++) fails.push((await loginAt(ipC, "limit.user@test.com", "wrong-" + i)).status);
    check("...so 3 real wrong guesses are still allowed → 401 each", fails.every((s) => s === 401));
    r = await loginAt(ipC, "limit.user@test.com", "wrong-4");
    check("...and the 4th → 429", r.status === 429);

    console.log("\nRate limiting: all sign-up/login requests per IP");
    const ipD = "198.51.100.5";
    let codes = [];
    for (let i = 0; i < 6; i++) codes.push((await req("POST", "/api/auth/register", { ip: ipD, body: {} })).status);
    for (let i = 0; i < 6; i++) codes.push((await req("POST", "/api/auth/seller/register", { ip: ipD, body: {} })).status);
    check("12 sign-up requests from one IP → all answered normally (400, bad forms)", codes.every((s) => s === 400));
    r = await loginAt(ipD, "limit.other@test.com", "secret123");
    check("the 13th request from that IP (a login) → 429", r.status === 429);
    check("...code 'too_many_requests'", r.body.code === "too_many_requests");
    r = await req("GET", "/api/categories", { ip: ipD });
    check("...but the rest of the app still works for that IP → 200", r.status === 200);
    r = await loginAt("198.51.100.6", "limit.other@test.com", "secret123");
    check("another IP is unaffected → 200", r.status === 200);

    console.log("\nTrust proxy: the IP the server sees");
    r = await req("GET", "/api/health/ip", { ip: "203.0.113.7" });
    check("GET /api/health/ip shows the visitor's IP from X-Forwarded-For", r.status === 200 && r.body.ip === "203.0.113.7");
    check("...plus the raw forwarded chain and the hops setting, for checking Render", r.body.forwardedFor === "203.0.113.7" && r.body.trustProxyHops === 1);
    // express-rate-limit checks its own setup and prints a warning (an error
    // object with a code starting "ERR_ERL_") if something is wrong, e.g. the
    // IP handling. It keeps working, so a mistake would go unnoticed without
    // this check.
    check(
      "the rate limiter printed NO configuration warnings",
      !errorLog.some((args) => args.some((a) => String(a?.code || "").startsWith("ERR_ERL")))
    );

    // ================= Products: POST /api/products =================
    console.log("\nPOST /api/products");

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
    check(
      "a new product starts on the placeholder image",
      r.body?.product?.imageUrl === "/images/products/default.jpg"
    );
    const productId = r.body?.product?._id;

    // imageUrl is NOT in the create whitelist, so a client can't point it at an
    // arbitrary URL. zod strips it and the schema default applies.
    r = await req("POST", "/api/products", {
      token: sellerToken,
      body: { name: "Rice", nameAr: "أرز", category: category.id, imageUrl: "https://evil.example/x.png" },
    });
    check(
      "a client-sent imageUrl is ignored → still the placeholder",
      r.status === 201 && r.body?.product?.imageUrl === "/images/products/default.jpg"
    );
    // Remove it again: the browse tests below count on "Sugar" being the only product.
    await Product.deleteOne({ _id: r.body?.product?._id });

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

    // ========= Home (Step 10, Slice 1): featured + new arrivals =========
    console.log("\nGET /api/products/featured + /new, PATCH /:id/feature");

    // --- FALLBACK: nothing is featured yet ---
    // No product has been flagged at this point, so /featured must NOT be empty —
    // it falls back to the newest products so the homepage strip is never blank.
    let rAll = await req("GET", "/api/products?limit=1");
    const totalProducts = rAll.body?.total; // how many products exist right now
    r = await req("GET", "/api/products/featured");
    const fallbackFeatured = r.body?.products || [];
    check("featured (none flagged) → non-empty fallback to newest", fallbackFeatured.length > 0);
    check("featured fallback size = min(10, total)", fallbackFeatured.length === Math.min(10, totalProducts));
    const fbTimes = fallbackFeatured.map((p) => new Date(p.createdAt).getTime());
    check("featured fallback is newest-first", fbTimes.every((t, i) => i === 0 || fbTimes[i - 1] >= t));
    check(
      "featured populates category name/nameAr only (no slug)",
      !!fallbackFeatured[0]?.category?.name && fallbackFeatured[0]?.category?.slug === undefined
    );

    // Two products to feature. We set createdAt explicitly (save with
    // timestamps:false so Mongoose doesn't overwrite it) so featNew is provably
    // newer than featOld — that makes the newest-first assertions deterministic
    // instead of depending on same-millisecond insertion order. featNew's time is
    // "now", so it's also the newest product in the whole catalog.
    const nowMs = Date.now();
    const featOld = await new Product({
      name: "Featured Old", nameAr: "مميز قديم", category: category._id,
      createdAt: new Date(nowMs - 60000), updatedAt: new Date(nowMs - 60000),
    }).save({ timestamps: false });
    const featNew = await new Product({
      name: "Featured New", nameAr: "مميز جديد", category: category._id,
      createdAt: new Date(nowMs), updatedAt: new Date(nowMs),
    }).save({ timestamps: false });

    // --- ROLE GATE on the admin-only feature route ---
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { body: { isFeatured: true } });
    check("feature: no token → 401", r.status === 401);
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: sellerToken, body: { isFeatured: true } });
    check("feature: seller → 403 (editorial, admin only)", r.status === 403);
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: customerToken, body: { isFeatured: true } });
    check("feature: customer → 403", r.status === 403);

    // --- validation + not-found on the feature route ---
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: adminToken, body: { isFeatured: "yes" } });
    check("feature: non-boolean body → 400", r.status === 400);
    r = await req("PATCH", `/api/products/${FAKE_ID}/feature`, { token: adminToken, body: { isFeatured: true } });
    check("feature: missing product → 404", r.status === 404);
    r = await req("PATCH", "/api/products/abc/feature", { token: adminToken, body: { isFeatured: true } });
    check("feature: invalid id → 400", r.status === 400 && r.body.error === "Invalid product id");

    // --- admin flags both (and proves the SET is idempotent) ---
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: adminToken, body: { isFeatured: true } });
    check("feature: admin sets true → 200 + isFeatured true", r.status === 200 && r.body?.product?.isFeatured === true);
    check("feature: response populates category", r.body?.product?.category?.name === "Grocery");
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: adminToken, body: { isFeatured: true } });
    check("feature: setting true again is idempotent (still true)", r.body?.product?.isFeatured === true);
    await req("PATCH", `/api/products/${featNew.id}/feature`, { token: adminToken, body: { isFeatured: true } });

    // --- FILTERED: /featured now returns ONLY the flagged products, newest first ---
    r = await req("GET", "/api/products/featured");
    const featured = r.body?.products || [];
    const featuredIds = featured.map((p) => p._id);
    check("featured now returns exactly the 2 flagged products", featured.length === 2);
    check("featured are newest-first (featNew before featOld)", featuredIds[0] === featNew.id && featuredIds[1] === featOld.id);
    check("featured excludes un-flagged products", !featuredIds.includes(productId));

    // --- un-feature works too (set false removes it) ---
    r = await req("PATCH", `/api/products/${featOld.id}/feature`, { token: adminToken, body: { isFeatured: false } });
    check("feature: admin sets false → 200 + isFeatured false", r.status === 200 && r.body?.product?.isFeatured === false);
    r = await req("GET", "/api/products/featured");
    check("un-featured product drops out of /featured", !(r.body?.products || []).map((p) => p._id).includes(featOld.id));

    // --- NEW ARRIVALS: newest-first + respects limit + paginated shape ---
    r = await req("GET", "/api/products/new?limit=3");
    const newArr = r.body?.products || [];
    check("new: respects limit (3)", newArr.length === 3);
    check("new: paginated shape (page/limit/total)", r.body?.page === 1 && r.body?.limit === 3 && r.body?.total === totalProducts + 2);
    const naTimes = newArr.map((p) => new Date(p.createdAt).getTime());
    check("new: sorted newest-first by createdAt", naTimes.every((t, i) => i === 0 || naTimes[i - 1] >= t));
    check("new: most recently created product (featNew) is first", newArr[0]?._id === featNew.id);
    check("new: category populated name/nameAr only", !!newArr[0]?.category?.name && newArr[0]?.category?.slug === undefined);

    // ============ Home (Step 10, Slice 2): top stores ============
    console.log("\nGET /api/shops/top");

    // Set each shop's denormalized rating DIRECTLY (updateOne bypasses the review
    // recalc), so ordering is fully under our control regardless of what earlier
    // review tests left behind. The interesting cases:
    //   shopA  5.0 / 20  ┐ tie on ratingAvg — shopA wins on MORE reviews
    //   shopB  5.0 /  1  ┘
    //   otherShop 4.0 / 50  → lower avg, ranks last despite the most reviews
    //   inactiveShop 5.0 / 999 → highest everything, but MUST be excluded (hidden)
    await Shop.updateOne({ _id: shopA._id }, { ratingAvg: 5.0, ratingCount: 20 });
    await Shop.updateOne({ _id: shopB._id }, { ratingAvg: 5.0, ratingCount: 1 });
    await Shop.updateOne({ _id: otherShop._id }, { ratingAvg: 4.0, ratingCount: 50 });
    await Shop.updateOne({ _id: inactiveShop._id }, { ratingAvg: 5.0, ratingCount: 999 });

    r = await req("GET", "/api/shops/top?limit=50");
    const top = r.body?.shops || [];
    const topIds = top.map((s) => String(s._id));
    check("top: 200 with a shops array", r.status === 200 && Array.isArray(top));
    check("top: only the 3 ACTIVE shops (inactive excluded)", top.length === 3);
    check("top: inactive shop excluded even with the highest rating", !topIds.includes(String(inactiveShop._id)));
    check("top: highest ratingAvg first, tiebreaker by ratingCount (A, B, other)",
      topIds[0] === String(shopA._id) && topIds[1] === String(shopB._id) && topIds[2] === String(otherShop._id));

    // Safe public projection: no owner (and therefore no owner email) leaks.
    const card = top[0];
    check("top: safe fields present (name, phone, ratingAvg, ratingCount)",
      card.name !== undefined && card.phone !== undefined && card.ratingAvg !== undefined && card.ratingCount !== undefined);
    check("top: owner NOT leaked", card.owner === undefined);

    r = await req("GET", "/api/shops/top?limit=2");
    check("top: respects limit (2 → shopA, shopB)", (r.body?.shops || []).length === 2);

    // ========= Home (Step 10, Slice 3): bundled GET /api/home =========
    console.log("\nGET /api/home");

    r = await req("GET", "/api/home");
    const home = r.body || {};
    check("home: 200", r.status === 200);
    check("home: has featured/newArrivals/topStores arrays",
      Array.isArray(home.featured) && Array.isArray(home.newArrivals) && Array.isArray(home.topStores));
    check("home: all three lists non-empty (data exists)",
      home.featured.length > 0 && home.newArrivals.length > 0 && home.topStores.length > 0);

    // The bundle must MATCH the standalone endpoints (they share the same helpers,
    // so their first item — the top of each deterministic sort — must be identical).
    const rHomeNew = await req("GET", "/api/products/new?limit=8");
    check("home.newArrivals matches /api/products/new (same first product)",
      home.newArrivals[0]?._id === rHomeNew.body?.products?.[0]?._id);
    const rHomeTop = await req("GET", "/api/shops/top?limit=8");
    check("home.topStores matches /api/shops/top (same first shop)",
      String(home.topStores[0]?._id) === String(rHomeTop.body?.shops?.[0]?._id));
    const rHomeFeat = await req("GET", "/api/products/featured?limit=8");
    check("home.featured matches /api/products/featured (same first product)",
      home.featured[0]?._id === rHomeFeat.body?.products?.[0]?._id);

    // topStores goes through the same safe projection here too — no owner leak.
    check("home: topStores owner NOT leaked", home.topStores[0]?.owner === undefined);

    // ============ Global Search (Slice 1): GET /api/search — products ============
    console.log("\nGET /api/search (Slice 1: products)");

    // Seed 6 products sharing a distinctive token so we can prove the dropdown
    // CAPS each group at 5 while `counts` still reports the TRUE total (6). The
    // token is deliberately weird so nothing else in the catalog matches it.
    for (let i = 1; i <= 6; i++) {
      await Product.create({
        name: `Zzsearch Item ${i}`,
        nameAr: `منتج بحث ${i}`,
        category: category._id,
      });
    }
    // A product whose distinctive term lives ONLY in nameAr (its English name has
    // no such token) — proves Arabic matching works, not just English.
    await Product.create({
      name: "Arabic Only Match",
      nameAr: "بحثفريد",
      category: category._id,
    });

    r = await req("GET", "/api/search?q=Zzsearch");
    check(
      "bundle shape: query + products[] + counts{}",
      r.status === 200 &&
        typeof r.body?.query === "string" &&
        Array.isArray(r.body?.products) &&
        typeof r.body?.counts === "object"
    );
    check("products capped at DROPDOWN_LIMIT (5 of 6)", r.body?.products?.length === 5);
    check("counts.products reports the TRUE total (6)", r.body?.counts?.products === 6);
    check(
      "every returned product actually matches the query",
      r.body.products.every((p) => /zzsearch/i.test(p.name) || /zzsearch/i.test(p.nameAr))
    );
    check(
      "results carry category populated (name/nameAr only, no slug)",
      !!r.body.products[0]?.category?.name && r.body.products[0]?.category?.slug === undefined
    );

    // Case-insensitive PARTIAL match on the English name (finds "Sugar").
    r = await req("GET", "/api/search?q=sug");
    check(
      "q=sug finds Sugar by name (partial, case-insensitive)",
      r.status === 200 && r.body.products.some((p) => p.name === "Sugar")
    );

    // Match on the ARABIC name only — the term isn't in the English name.
    r = await req("GET", "/api/search?q=" + encodeURIComponent("بحثفريد"));
    check(
      "q=بحثفريد finds the product via nameAr",
      r.status === 200 && r.body.products.some((p) => p.name === "Arabic Only Match")
    );
    check("counts.products for the nameAr-only match is 1", r.body?.counts?.products === 1);

    // Empty query → nothing to search: empty group + zero count, still 200 (not 400).
    r = await req("GET", "/api/search?q=");
    check(
      "empty q → 200 with empty products and count 0",
      r.status === 200 &&
        Array.isArray(r.body?.products) &&
        r.body.products.length === 0 &&
        r.body?.counts?.products === 0
    );

    // A regex metacharacter must be treated literally, never crash the server.
    r = await req("GET", "/api/search?q=" + encodeURIComponent("("));
    check("q='(' does not crash (regex escaped) → 200", r.status === 200);

    // ============ Global Search (Slice 2): shops in the bundle ============
    console.log("\nGET /api/search (Slice 2: shops)");

    // Four shops that all match the token "Zqshop" — but via DIFFERENT fields, to
    // prove a shop is found by name OR area OR description. The 4th is INACTIVE and
    // must be excluded even though its name matches. (Description is matched by the
    // filter but isn't in the public projection, so it won't be echoed back.)
    await Shop.create({ owner: seller._id, name: "Zqshop Market", phone: "9" });
    await Shop.create({ owner: seller._id, name: "Plain Store", phone: "9", area: "Zqshop District" });
    await Shop.create({ owner: seller._id, name: "Another Store", phone: "9", description: "the best Zqshop deals in town" });
    await Shop.create({ owner: seller._id, name: "Zqshop Hidden", phone: "9", isActive: false });

    r = await req("GET", "/api/search?q=Zqshop");
    check("bundle now includes a shops[] array", r.status === 200 && Array.isArray(r.body?.shops));
    const shopNames = (r.body?.shops || []).map((s) => s.name);
    check("shop matched by NAME is found (Zqshop Market)", shopNames.includes("Zqshop Market"));
    check("shop matched by AREA is found (Plain Store)", shopNames.includes("Plain Store"));
    check("shop matched by DESCRIPTION is found (Another Store)", shopNames.includes("Another Store"));
    check("counts.shops = 3 active matches (inactive excluded)", r.body?.counts?.shops === 3);
    check("inactive shop excluded despite matching name", !shopNames.includes("Zqshop Hidden"));
    check("shop carries safe public fields (name, phone, area)",
      r.body.shops[0]?.name !== undefined && r.body.shops[0]?.phone !== undefined);
    check("shop owner NOT leaked", r.body.shops.every((s) => s.owner === undefined));
    check("shop isActive NOT leaked (internal flag)", r.body.shops.every((s) => s.isActive === undefined));

    // ============ Global Search (Slice 3): categories in the bundle ============
    console.log("\nGET /api/search (Slice 3: categories)");

    // A category matched by NAME ("Zqcat"), one matched only by its Arabic nameAr,
    // and an INACTIVE one that must be excluded even though its name matches.
    // (Slugs are unique, so each gets its own.)
    await Category.create({ name: "Zqcat Supplies", nameAr: "لوازم", slug: "zqcat-supplies" });
    await Category.create({ name: "Plain Category", nameAr: "زقكاتفريد", slug: "plain-cat-zq" });
    await Category.create({ name: "Zqcat Hidden", nameAr: "مخفي", slug: "zqcat-hidden", isActive: false });

    r = await req("GET", "/api/search?q=Zqcat");
    check("bundle now includes a categories[] array", r.status === 200 && Array.isArray(r.body?.categories));
    const catNames = (r.body?.categories || []).map((c) => c.name);
    check("category matched by NAME is found (Zqcat Supplies)", catNames.includes("Zqcat Supplies"));
    check("counts.categories = 1 active name match", r.body?.counts?.categories === 1);
    check("inactive category excluded despite matching name", !catNames.includes("Zqcat Hidden"));

    // Match on the ARABIC name only — the token isn't in the English name.
    r = await req("GET", "/api/search?q=" + encodeURIComponent("زقكاتفريد"));
    check(
      "q=زقكاتفريد finds the category via nameAr",
      (r.body?.categories || []).some((c) => c.name === "Plain Category")
    );
    check("counts.categories for the nameAr-only match is 1", r.body?.counts?.categories === 1);

    // Full bundle sanity: a query that hits ALL THREE types at once returns all
    // three populated. "Zq" is the shared prefix of our shop + category test tokens
    // (Zqshop / Zqcat); "Zzsearch" products don't match "Zq", so we add a product
    // that does, to prove one query can light up every group.
    await Product.create({ name: "Zqproduct Sample", nameAr: "عينة", category: category._id });
    r = await req("GET", "/api/search?q=Zq");
    check(
      "one query fills products + shops + categories together",
      r.body?.products?.length > 0 && r.body?.shops?.length > 0 && r.body?.categories?.length > 0
    );
    check(
      "counts present for all three groups",
      typeof r.body?.counts?.products === "number" &&
        typeof r.body?.counts?.shops === "number" &&
        typeof r.body?.counts?.categories === "number"
    );

    // ============ Global Search (Slice 4): ?type= "see all" paginated ============
    console.log("\nGET /api/search?type=… (Slice 4: see-all pagination)");

    // We seeded 6 "Zzsearch" products back in Slice 1 — perfect for paging.
    r = await req("GET", "/api/search?q=Zzsearch&type=products&limit=2");
    check(
      "type=products → { query, type, results, page, limit, total }",
      r.status === 200 &&
        r.body?.type === "products" &&
        Array.isArray(r.body?.results) &&
        r.body?.page === 1 &&
        r.body?.limit === 2 &&
        typeof r.body?.total === "number"
    );
    check("see-all page 1 (limit 2) → 2 results", r.body?.results?.length === 2);
    check("total counts ALL matches, not just the page (6)", r.body?.total === 6);

    r = await req("GET", "/api/search?q=Zzsearch&type=products&page=3&limit=2");
    check("see-all page 3 of limit 2 → the final 2 of 6", r.body?.results?.length === 2 && r.body?.page === 3);

    // The "see all" page is NOT capped at the dropdown's 5 — it pages the full set.
    r = await req("GET", "/api/search?q=Zzsearch&type=products&limit=50");
    check("see-all returns beyond the dropdown cap of 5 (all 6)", r.body?.results?.length === 6);

    // Shops/categories see-all obey the same safe rules as the bundle.
    r = await req("GET", "/api/search?q=Zqshop&type=shops&limit=50");
    check(
      "type=shops → only active matches (3), owner never leaked",
      r.body?.total === 3 && r.body.results.every((s) => s.owner === undefined)
    );

    r = await req("GET", "/api/search?q=Zqcat&type=categories");
    check("type=categories → the 1 active name match", r.body?.type === "categories" && r.body?.total === 1);

    // Unknown type → 400 (a caller mistake, not a silent fallback to the bundle).
    r = await req("GET", "/api/search?q=x&type=bogus");
    check("unknown type → 400 Invalid search type", r.status === 400 && r.body?.error === "Invalid search type");

    // Empty q in see-all mode → empty results + total 0, still 200.
    r = await req("GET", "/api/search?type=products&q=");
    check(
      "empty q in see-all → 200, empty results, total 0",
      r.status === 200 &&
        Array.isArray(r.body?.results) &&
        r.body.results.length === 0 &&
        r.body?.total === 0
    );

    // ======================= Order fixtures =========================
    // A fresh customer with their own cart, plus listings in TWO different
    // shops, so checkout has to split one cart into two orders.
    const orderCustomer = await User.create({
      name: "Order Customer",
      email: "ordercustomer@test.com",
      passwordHash: "x",
      phone: "0591111111",
      role: "customer",
    });
    const orderCustomerToken = tokenFor(orderCustomer);

    const orderProductA = await Product.create({
      name: "Order Milk",
      nameAr: "حليب الطلب",
      category: category._id,
      unit: "L",
    });
    const orderProductB = await Product.create({
      name: "Order Bread",
      nameAr: "خبز الطلب",
      category: category._id,
      unit: "piece",
    });
    // shopA (owned by `seller`) and otherShop (owned by `otherSeller`).
    const orderListingA = await Listing.create({
      shop: shopA._id,
      product: orderProductA._id,
      price: 10,
    });
    const orderListingB = await Listing.create({
      shop: otherShop._id,
      product: orderProductB._id,
      price: 4,
    });

    // Small helpers for this section.
    const addToCart = (token, listingId, quantity) =>
      req("POST", "/api/cart/items", { token, body: { listing: listingId, quantity } });
    const findOrderForShop = (body, shopName) =>
      body?.orders?.find((o) => o.shop?.name === shopName);

    // ================= Orders: POST /api/orders =================
    console.log("\nPOST /api/orders");

    r = await req("POST", "/api/orders", { body: { contactPhone: "0599" } });
    check("no token → 401", r.status === 401);

    r = await req("POST", "/api/orders", {
      token: sellerToken,
      body: { contactPhone: "0599" },
    });
    check("non-customer (seller) → 403", r.status === 403);

    // This customer has never touched their cart → nothing to order.
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    check("no cart at all → 400 Cart is empty", r.status === 400 && r.body?.error === "Cart is empty");

    // Build a cart that MIXES two shops: 3 × Milk (₪10) from Shop A,
    // 2 × Bread (₪4) from Other Shop.
    await addToCart(orderCustomerToken, orderListingA.id, 3);
    await addToCart(orderCustomerToken, orderListingB.id, 2);

    // (zod reports its own "expected string, received undefined" for a MISSING
    // field — our custom message covers the empty-string case. Same as the
    // cart's "missing listing → 400" check above: we assert the status.)
    r = await req("POST", "/api/orders", { token: orderCustomerToken, body: {} });
    check("missing contactPhone → 400", r.status === 400);

    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "" },
    });
    check("empty contactPhone → 400 Contact phone is required", r.status === 400 && r.body?.error === "Contact phone is required");

    // --- the happy path: one cart becomes TWO orders ---
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599123456", note: "call before 6pm" },
    });
    check("checkout → 201", r.status === 201);
    check("one cart with 2 shops → 2 orders", r.body?.orders?.length === 2);

    const shopAOrder = findOrderForShop(r.body, "Shop A");
    const otherShopOrder = findOrderForShop(r.body, "Other Shop");
    const shopAOrderId = shopAOrder?._id;

    check("an order per shop, each with ONE shop", !!shopAOrder && !!otherShopOrder);
    check("Shop A order has only its own line", shopAOrder?.items?.length === 1 && shopAOrder.items[0].productName === "Order Milk");
    check("Other Shop order has only its own line", otherShopOrder?.items?.length === 1 && otherShopOrder.items[0].productName === "Order Bread");
    check("subtotal = 3 × ₪10 = 30", shopAOrder?.subtotal === 30);
    check("total equals subtotal (no fees in Step 12)", shopAOrder?.total === 30);
    check("second shop's subtotal = 2 × ₪4 = 8", otherShopOrder?.subtotal === 8);
    check("status starts at pending", shopAOrder?.status === "pending");
    check("contactPhone + note stored", shopAOrder?.contactPhone === "0599123456" && shopAOrder?.note === "call before 6pm");

    // The line is a frozen photograph: price + display fields copied onto it.
    const shopALine = shopAOrder?.items?.[0];
    check("line froze priceAtOrder (10)", shopALine?.priceAtOrder === 10);
    check("line froze the product names + unit", shopALine?.productNameAr === "حليب الطلب" && shopALine?.unit === "L");
    check("line keeps listing + product ids for traceability", !!shopALine?.listing && !!shopALine?.product);

    // Safe population: the seller gets the customer's name + phone (that's the
    // whole point of the app), but never their email or password hash.
    check("customer populated with name + phone", shopAOrder?.customer?.name === "Order Customer" && shopAOrder?.customer?.phone !== undefined);
    check("no email leaked on the customer", shopAOrder?.customer?.email === undefined);
    check("no owner leaked on the shop", shopAOrder?.shop?.owner === undefined);

    // The cart has done its job and is now empty...
    r = await req("GET", "/api/cart", { token: orderCustomerToken });
    check("cart is emptied by checkout", r.body?.cart?.items?.length === 0);

    // ...which makes the cart its own idempotency token: a double-submit can't
    // silently create a second identical set of orders.
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599123456" },
    });
    check("double-submit → 400 Cart is empty (no duplicate orders)", r.status === 400 && r.body?.error === "Cart is empty");

    // --- refusals: things that must block a checkout ---
    // Out of stock. Note this listing goes in shopB, not shopA: orderProductA
    // already has a shopA listing, and the unique (shop, product) index would
    // reject a second one.
    const oosListing = await Listing.create({
      shop: shopB._id,
      product: orderProductA._id,
      price: 7,
      inStock: false,
    });
    await addToCart(orderCustomerToken, oosListing.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    check("out-of-stock item → 409", r.status === 409 && r.body?.error === "Order Milk is out of stock");
    await req("DELETE", "/api/cart", { token: orderCustomerToken });

    // A shop that has been hidden can't take orders.
    const hiddenListing = await Listing.create({
      shop: inactiveShop._id,
      product: orderProductB._id,
      price: 5,
    });
    await addToCart(orderCustomerToken, hiddenListing.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    check("inactive shop → 409", r.status === 409 && r.body?.error === "Hidden Shop is not accepting orders right now");
    await req("DELETE", "/api/cart", { token: orderCustomerToken });

    // A listing deleted AFTER it went into the cart leaves a dangling line. We
    // must refuse clearly, not crash and not silently drop it.
    const doomedListing = await Listing.create({
      shop: shopB._id,
      product: orderProductB._id,
      price: 6,
    });
    await addToCart(orderCustomerToken, doomedListing.id, 1);
    await Listing.deleteOne({ _id: doomedListing._id });
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    check("deleted listing in cart → 409 (not a 500)", r.status === 409 && /no longer available/.test(r.body?.error || ""));
    await req("DELETE", "/api/cart", { token: orderCustomerToken });

    // --- THE SECURITY TEST ---
    // A client must never be able to set its own price, total, status or owner.
    // All of those keys are simply absent from the zod whitelist, so they're
    // stripped. This check is silent when it works and catastrophic if it ever
    // stops working.
    await addToCart(orderCustomerToken, orderListingA.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: {
        contactPhone: "0500000000",
        subtotal: 1,
        total: 1,
        status: "completed",
        customer: customer.id,
        shop: otherShop.id,
        items: [{ productName: "Free stuff", priceAtOrder: 0, quantity: 99 }],
      },
    });
    const hacked = r.body?.orders?.[0];
    check("injected total/subtotal ignored → server computed ₪10", r.status === 201 && hacked?.total === 10 && hacked?.subtotal === 10);
    check("injected status ignored → pending", hacked?.status === "pending");
    check("injected items ignored → the real cart line", hacked?.items?.length === 1 && hacked.items[0].productName === "Order Milk");
    check("injected customer ignored → the token's user", hacked?.customer?.name === "Order Customer");
    const secondCheckoutOrderId = hacked?._id;

    // ================= Orders: GET /api/orders =================
    console.log("\nGET /api/orders");

    r = await req("GET", "/api/orders");
    check("no token → 401", r.status === 401);

    r = await req("GET", "/api/orders", { token: sellerToken });
    check("non-customer (seller) → 403", r.status === 403);

    r = await req("GET", "/api/orders", { token: orderCustomerToken });
    check("my orders → 200", r.status === 200);
    check("paginated shape { orders, page, limit, total }", Array.isArray(r.body?.orders) && r.body?.page === 1 && r.body?.limit === 20 && r.body?.total === 3);
    check("newest checkout first", r.body?.orders?.[0]?._id === secondCheckoutOrderId);
    check("every order belongs to me", r.body?.orders?.every((o) => o.customer?.name === "Order Customer"));

    // A customer with no orders sees an empty page, not an error.
    r = await req("GET", "/api/orders", { token: customer2Token });
    check("customer with no orders → empty page, 200", r.status === 200 && r.body?.total === 0);

    r = await req("GET", "/api/orders?status=banana", { token: orderCustomerToken });
    check("unknown ?status → 400 Invalid status", r.status === 400 && r.body?.error === "Invalid status");

    r = await req("GET", "/api/orders?status=pending", { token: orderCustomerToken });
    check("?status=pending → all 3", r.body?.total === 3);

    r = await req("GET", "/api/orders?status=completed", { token: orderCustomerToken });
    check("?status=completed → none yet", r.body?.total === 0);

    r = await req("GET", "/api/orders?limit=2", { token: orderCustomerToken });
    check("?limit=2 → 2 of 3", r.body?.orders?.length === 2 && r.body?.total === 3);

    // ================= Orders: GET /api/orders/:id =================
    console.log("\nGET /api/orders/:id");

    r = await req("GET", `/api/orders/${shopAOrderId}`);
    check("no token → 401", r.status === 401);

    r = await req("GET", "/api/orders/abc", { token: orderCustomerToken });
    check("invalid order id → 400", r.status === 400 && r.body?.error === "Invalid order id");

    r = await req("GET", `/api/orders/${FAKE_ID}`, { token: orderCustomerToken });
    check("unknown order id → 404", r.status === 404 && r.body?.error === "Order not found");

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: orderCustomerToken });
    check("the customer who placed it → 200", r.status === 200 && r.body?.order?._id === shopAOrderId);

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: sellerToken });
    check("the seller who owns the shop → 200", r.status === 200);

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: adminToken });
    check("an admin → 200", r.status === 200);

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: customer2Token });
    check("a different customer → 403", r.status === 403 && r.body?.error === "Forbidden");

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: tokenFor(otherSeller) });
    check("a seller who doesn't own the shop → 403", r.status === 403);

    // ============ THE POINT OF THE WHOLE FEATURE: frozen prices ============
    // The shop raises its price after the order was placed. The order must NOT
    // change — it records what was agreed, not what things cost today.
    await Listing.findByIdAndUpdate(orderListingA._id, { price: 99 });

    r = await req("GET", `/api/products/${orderProductA.id}/listings`);
    const liveShopA = r.body?.listings?.find((l) => l.shop?.name === "Shop A");
    check("the LIVE listing price really did change to 99", liveShopA?.price === 99);

    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: orderCustomerToken });
    check("the order STILL shows priceAtOrder 10", r.body?.order?.items?.[0]?.priceAtOrder === 10);
    check("the order's subtotal is unchanged (30)", r.body?.order?.subtotal === 30);

    // ============ Orders: GET /api/orders/incoming (seller inbox) ============
    console.log("\nGET /api/orders/incoming");
    // State of play: orderCustomer has 3 orders — two at shopA (owned by
    // `seller`) and one at otherShop (owned by `otherSeller`). All still pending.
    const otherShopOrderId = otherShopOrder?._id;

    r = await req("GET", "/api/orders/incoming");
    check("no token → 401", r.status === 401);

    r = await req("GET", "/api/orders/incoming", { token: orderCustomerToken });
    check("a customer → 403", r.status === 403);

    // ROUTE ORDER PROOF: if /:id were registered first, Express would read
    // "incoming" as an order id and answer 400 "Invalid order id".
    r = await req("GET", "/api/orders/incoming", { token: sellerToken });
    check("/incoming is NOT swallowed by /:id → 200", r.status === 200);
    check("paginated shape { orders, page, limit, total }", Array.isArray(r.body?.orders) && r.body?.page === 1 && r.body?.total === 2);
    check("seller sees BOTH of their shopA orders", r.body?.orders?.every((o) => o.shop?.name === "Shop A"));
    check("seller never sees another shop's order", !r.body?.orders?.some((o) => o._id === otherShopOrderId));

    // A seller may own several shops, so the inbox spans all of them — and
    // stops exactly at the shops they own.
    r = await req("GET", "/api/orders/incoming", { token: tokenFor(otherSeller) });
    check("the OTHER seller sees only their own 1 order", r.body?.total === 1 && r.body?.orders?.[0]?._id === otherShopOrderId);

    r = await req("GET", "/api/orders/incoming", { token: adminToken });
    check("an admin sees every order in the marketplace (3)", r.body?.total === 3);

    // $in: [] matches nothing, so this needs no special case in the controller.
    const shoplessSeller = await User.create({
      name: "Shopless Seller",
      email: "shopless@test.com",
      passwordHash: "x",
      role: "seller",
    });
    r = await req("GET", "/api/orders/incoming", { token: tokenFor(shoplessSeller) });
    check("a seller with no shops → empty page, 200 (not an error)", r.status === 200 && r.body?.total === 0);

    r = await req("GET", "/api/orders/incoming?status=banana", { token: sellerToken });
    check("unknown ?status → 400 Invalid status", r.status === 400 && r.body?.error === "Invalid status");

    // ?shop=<id>: one shop's inbox (slice 17.1). `seller` owns Shop A (2 orders)
    // and Shop B (none); otherShop (1 order) belongs to otherSeller.
    console.log("\nGET /api/orders/incoming?shop= (one shop's inbox)");

    r = await req("GET", `/api/orders/incoming?shop=${shopA._id}`, { token: sellerToken });
    check("my Shop A → its 2 orders", r.status === 200 && r.body?.total === 2 && r.body.orders.every((o) => o.shop?.name === "Shop A"));

    r = await req("GET", `/api/orders/incoming?shop=${shopB._id}`, { token: sellerToken });
    check("my Shop B (no orders yet) → empty page, 200", r.status === 200 && r.body?.total === 0);

    r = await req("GET", `/api/orders/incoming?shop=${otherShop._id}`, { token: sellerToken });
    check("another seller's shop → 403", r.status === 403);

    r = await req("GET", `/api/orders/incoming?shop=${shopA._id}`, { token: tokenFor(otherSeller) });
    check("...and the other way round → 403", r.status === 403);

    r = await req("GET", `/api/orders/incoming?shop=${FAKE_ID}`, { token: sellerToken });
    check("a shop id that doesn't exist → 403 (it isn't one of mine)", r.status === 403);

    r = await req("GET", "/api/orders/incoming?shop=banana", { token: sellerToken });
    check("a malformed shop id → 400 Invalid shop id", r.status === 400 && r.body?.error === "Invalid shop id");

    r = await req("GET", `/api/orders/incoming?shop=${shopA._id}&shop=${shopB._id}`, { token: sellerToken });
    check("?shop given twice → 400 (not silently one of them)", r.status === 400);

    r = await req("GET", `/api/orders/incoming?shop=${otherShop._id}`, { token: adminToken });
    check("an admin may look at ANY shop's inbox", r.status === 200 && r.body?.total === 1 && r.body.orders[0]._id === otherShopOrderId);

    r = await req("GET", `/api/orders/incoming?shop=${shopA._id}&status=pending`, { token: sellerToken });
    check("?shop and ?status combine", r.status === 200 && r.body?.total === 2);

    r = await req("GET", `/api/orders/incoming?shop=${shopA._id}&status=completed`, { token: sellerToken });
    check("...and narrow each other (no completed orders yet)", r.status === 200 && r.body?.total === 0);

    // ============ Orders: PATCH /api/orders/:id/status ============
    console.log("\nPATCH /api/orders/:id/status");

    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, { body: { status: "accepted" } });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", "/api/orders/abc/status", {
      token: sellerToken,
      body: { status: "accepted" },
    });
    check("invalid order id → 400", r.status === 400 && r.body?.error === "Invalid order id");

    r = await req("PATCH", `/api/orders/${FAKE_ID}/status`, {
      token: sellerToken,
      body: { status: "accepted" },
    });
    check("unknown order → 404", r.status === 404 && r.body?.error === "Order not found");

    // A stranger is refused BEFORE the body is even looked at, so they learn
    // nothing about the order.
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: customer2Token,
      body: { status: "accepted" },
    });
    check("a stranger → 403", r.status === 403 && r.body?.error === "Forbidden");

    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "banana" },
    });
    check("not a real status → 400 Invalid status", r.status === 400 && r.body?.error === "Invalid status");

    // 403 vs 409, the distinction that matters:
    // the move EXISTS but not for a customer → 403.
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: orderCustomerToken,
      body: { status: "accepted" },
    });
    check("customer tries to ACCEPT their own order → 403 (not their move)", r.status === 403);

    // the move doesn't exist from here FOR ANYONE → 409.
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "completed" },
    });
    check("pending → completed skips a step → 409", r.status === 409 && r.body?.error === "Cannot change a pending order to completed");

    // --- the happy path: the seller walks one order all the way through ---
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "accepted" },
    });
    check("seller: pending → accepted → 200", r.status === 200 && r.body?.order?.status === "accepted");

    // Now that it's accepted, the customer has lost the right to cancel — the
    // shop may already have set stock aside.
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: orderCustomerToken,
      body: { status: "cancelled" },
    });
    check("customer can NOT cancel an accepted order → 403", r.status === 403);

    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "ready" },
    });
    check("seller: accepted → ready → 200", r.status === 200 && r.body?.order?.status === "ready");

    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "completed" },
    });
    check("seller: ready → completed → 200", r.status === 200 && r.body?.order?.status === "completed");

    // Terminal means terminal — for everybody.
    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: sellerToken,
      body: { status: "pending" },
    });
    check("completed is terminal → 409", r.status === 409 && r.body?.error === "Cannot change a completed order to pending");

    r = await req("PATCH", `/api/orders/${shopAOrderId}/status`, {
      token: adminToken,
      body: { status: "ready" },
    });
    check("not even an admin can un-complete an order → 409", r.status === 409);

    // --- cancellation ---
    // A customer MAY cancel while it's still just a request.
    r = await req("PATCH", `/api/orders/${otherShopOrderId}/status`, {
      token: orderCustomerToken,
      body: { status: "cancelled", cancelReason: "changed my mind" },
    });
    check("customer cancels their own PENDING order → 200", r.status === 200 && r.body?.order?.status === "cancelled");
    check("cancelReason is stored", r.body?.order?.cancelReason === "changed my mind");

    r = await req("PATCH", `/api/orders/${otherShopOrderId}/status`, {
      token: tokenFor(otherSeller),
      body: { status: "accepted" },
    });
    check("cancelled is terminal too → 409", r.status === 409);

    // A seller may cancel from any non-terminal state.
    r = await req("PATCH", `/api/orders/${secondCheckoutOrderId}/status`, {
      token: sellerToken,
      body: { status: "cancelled", cancelReason: "sold out" },
    });
    check("seller cancels a pending order → 200", r.status === 200 && r.body?.order?.status === "cancelled");

    // cancelReason is ignored when the move isn't a cancellation, so it can't
    // linger misleadingly on a live order. Every order above is terminal by now,
    // so place a fresh one to move.
    await addToCart(orderCustomerToken, orderListingB.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    const freshOrderId = r.body?.orders?.[0]?._id;
    check("placed a fresh pending order to test against", r.status === 201 && !!freshOrderId);

    r = await req("PATCH", `/api/orders/${freshOrderId}/status`, {
      token: adminToken,
      body: { status: "accepted", cancelReason: "should be ignored" },
    });
    check("cancelReason ignored on a non-cancel move", r.status === 200 && r.body?.order?.status === "accepted" && r.body?.order?.cancelReason === undefined);

    // An admin may make any move a seller may — but only those.
    r = await req("PATCH", `/api/orders/${freshOrderId}/status`, {
      token: adminToken,
      body: { status: "ready" },
    });
    check("admin can drive a shop's order forward → 200", r.status === 200 && r.body?.order?.status === "ready");

    // The status filters now have something real to filter.
    r = await req("GET", "/api/orders?status=completed", { token: orderCustomerToken });
    check("my orders ?status=completed → the 1 we completed", r.body?.total === 1);

    r = await req("GET", "/api/orders/incoming?status=cancelled", { token: sellerToken });
    check("inbox ?status=cancelled → the 1 the seller cancelled", r.body?.total === 1);

    // ================= Areas: GET /api/areas =================
    console.log("\nGET /api/areas");

    const rimal = await Area.create({ name: "Rimal", nameAr: "الرمال", slug: "rimal" });
    const nuseirat = await Area.create({ name: "Nuseirat", nameAr: "النصيرات", slug: "nuseirat" });
    const khanYounis = await Area.create({ name: "Khan Younis", nameAr: "خان يونس", slug: "khan-younis" });
    const retiredArea = await Area.create({
      name: "Retired Area",
      nameAr: "منطقة قديمة",
      slug: "retired-area",
      isActive: false,
    });

    r = await req("GET", "/api/areas");
    check("public, no token needed → 200", r.status === 200);
    check("returns the 3 ACTIVE areas, hiding the retired one", r.body?.areas?.length === 3);
    check("sorted by English name (Khan Younis first)", r.body?.areas?.[0]?.name === "Khan Younis");
    check("each area carries its Arabic name + slug", r.body?.areas?.[0]?.nameAr === "خان يونس" && !!r.body.areas[0].slug);

    // The slug's unique index is what makes `npm run seed:areas` idempotent.
    let dupErr = null;
    try {
      await Area.create({ name: "Rimal Again", nameAr: "x", slug: "rimal" });
    } catch (err) {
      dupErr = err;
    }
    check("duplicate slug rejected by the unique index", dupErr?.code === 11000);

    // ========== Delivery zones: PATCH /api/shops/:shopId/delivery-zones ==========
    console.log("\nPATCH /api/shops/:shopId/delivery-zones");

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      body: { zones: [] },
    });
    check("no token → 401", r.status === 401);

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: customerToken,
      body: { zones: [] },
    });
    check("a customer → 403", r.status === 403);

    // A seller may configure only their OWN shop.
    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: tokenFor(otherSeller),
      body: { zones: [] },
    });
    check("a seller who doesn't own the shop → 403", r.status === 403 && r.body?.error === "Forbidden");

    r = await req("PATCH", "/api/shops/abc/delivery-zones", {
      token: sellerToken,
      body: { zones: [] },
    });
    check("invalid shop id → 400", r.status === 400 && r.body?.error === "Invalid shop id");

    r = await req("PATCH", `/api/shops/${FAKE_ID}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [] },
    });
    check("unknown shop → 404", r.status === 404 && r.body?.error === "Shop not found");

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: {},
    });
    check("missing zones array → 400", r.status === 400);

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [{ area: rimal.id, fee: -1 }] },
    });
    check("negative fee → 400", r.status === 400 && r.body?.error === "Fee cannot be negative");

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [{ area: "abc", fee: 5 }] },
    });
    check("invalid area id → 400 (body id, so 400 not 404)", r.status === 400 && r.body?.error === "Invalid area id");

    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [{ area: FAKE_ID, fee: 5 }] },
    });
    check("area doesn't exist → 400 Area not found", r.status === 400 && r.body?.error === "Area not found");

    // One shop must not list the same area twice with two different fees. This
    // is a per-document rule, so it can't be a unique index.
    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: {
        zones: [
          { area: rimal.id, fee: 5 },
          { area: rimal.id, fee: 9 },
        ],
      },
    });
    check("same area twice → 400 Duplicate delivery zone", r.status === 400 && r.body?.error === "Duplicate delivery zone");

    // --- the happy path ---
    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: {
        zones: [
          { area: rimal.id, fee: 5 },
          { area: nuseirat.id, fee: 10 },
        ],
      },
    });
    check("set 2 zones → 200", r.status === 200 && r.body?.shop?.deliveryZones?.length === 2);
    const rimalZone = r.body?.shop?.deliveryZones?.find((z) => z.area?.slug === "rimal");
    check("the zone's area is populated (name/nameAr/slug)", rimalZone?.area?.name === "Rimal" && rimalZone?.area?.nameAr === "الرمال");
    check("the fee is stored alongside it", rimalZone?.fee === 5);

    // A fee of 0 is a real answer — "I deliver here for free" — not a missing one.
    r = await req("PATCH", `/api/shops/${shopB.id}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [{ area: rimal.id, fee: 0 }] },
    });
    check("fee 0 (free delivery) is allowed", r.status === 200 && r.body?.shop?.deliveryZones?.[0]?.fee === 0);

    // An admin may configure any shop.
    r = await req("PATCH", `/api/shops/${otherShop.id}/delivery-zones`, {
      token: adminToken,
      body: { zones: [{ area: khanYounis.id, fee: 7 }] },
    });
    check("an admin can set any shop's zones → 200", r.status === 200);

    // REPLACES, doesn't merge — this is the surprising bit worth testing.
    r = await req("PATCH", `/api/shops/${shopA.id}/delivery-zones`, {
      token: sellerToken,
      body: { zones: [{ area: khanYounis.id, fee: 3 }] },
    });
    check("PATCH REPLACES the whole list (2 zones → 1)", r.status === 200 && r.body?.shop?.deliveryZones?.length === 1);
    check("the replacement is the new zone, not the old ones", r.body?.shop?.deliveryZones?.[0]?.area?.slug === "khan-younis");

    // ============ GET /api/shops?deliversTo= ============
    console.log("\nGET /api/shops?deliversTo=");
    // State: shopA → Khan Younis ₪3 · shopB → Rimal ₪0 · otherShop → Khan Younis ₪7
    // (inactiveShop has no zones and is hidden from public reads anyway.)

    r = await req("GET", "/api/shops");
    check("no filter → all active shops, unchanged behaviour", r.status === 200 && r.body?.shops?.length >= 3);

    r = await req("GET", `/api/shops?deliversTo=${khanYounis.id}`);
    const kyNames = (r.body?.shops || []).map((s) => s.name).sort();
    check("?deliversTo=Khan Younis → the 2 shops that cover it", r.status === 200 && kyNames.length === 2);
    check("...and they're the right two", kyNames[0] === "Other Shop" && kyNames[1] === "Shop A");

    r = await req("GET", `/api/shops?deliversTo=${rimal.id}`);
    check("?deliversTo=Rimal → only Shop B (fee 0)", r.body?.shops?.length === 1 && r.body.shops[0].name === "Shop B");

    r = await req("GET", `/api/shops?deliversTo=${nuseirat.id}`);
    check("?deliversTo=Nuseirat → nobody covers it any more", r.body?.shops?.length === 0);

    r = await req("GET", "/api/shops?deliversTo=abc");
    check("malformed area id → 400 (not a 500)", r.status === 400 && r.body?.error === "Invalid area id");

    // A shop's own profile shows its zones, so a customer can see the fee.
    r = await req("GET", `/api/shops/${shopA.id}`);
    check("GET /api/shops/:id includes populated deliveryZones", r.body?.shop?.deliveryZones?.[0]?.area?.name === "Khan Younis");
    check("...and still leaks no owner email", r.body?.shop?.owner?.email === undefined);

    // Zones are NOT added to the compact public projection, so the homepage
    // cards and search results are untouched by this feature.
    r = await req("GET", "/api/shops/top");
    check("/api/shops/top stays lean (no deliveryZones)", r.body?.shops?.[0]?.deliveryZones === undefined);

    // ============ GET /api/shops?owner= (slice 17.1b) ============
    // The public "all shops by this seller" page. `seller` owns Shop A, Shop B,
    // the CLOSED "Hidden Shop", and any shop earlier tests created for them, so
    // the expected names come from the database instead of a hard-coded list.
    console.log("\nGET /api/shops?owner= (all shops by one seller)");

    const sellerOpenNames = (await Shop.find({ owner: seller._id, isActive: true }))
      .map((s) => s.name)
      .sort();
    r = await req("GET", `/api/shops?owner=${seller._id}`);
    const byOwner = r.body?.shops || [];
    check(
      "public, no token → exactly that seller's OPEN shops",
      r.status === 200 && byOwner.map((s) => s.name).sort().join("|") === sellerOpenNames.join("|")
    );
    check("...including Shop A and Shop B", byOwner.some((s) => s.name === "Shop A") && byOwner.some((s) => s.name === "Shop B"));
    check("...but NOT their closed shop", !byOwner.some((s) => s.name === "Hidden Shop"));
    check("...and no other seller's shop", byOwner.every((s) => s.owner?._id === seller._id.toString()));
    check(
      "the owner shows ONLY their id and name (no email, no personal phone)",
      byOwner.every((s) => Object.keys(s.owner || {}).sort().join(",") === "_id,name" && s.owner.name === "Seller")
    );

    r = await req("GET", `/api/shops?owner=${otherSeller._id}`);
    check("the other seller → only their shop", r.status === 200 && r.body?.shops?.length === 1 && r.body.shops[0].name === "Other Shop");

    r = await req("GET", `/api/shops?owner=${customer._id}`);
    check("a customer's id (owns no shops) → [] and 200", r.status === 200 && r.body?.shops?.length === 0);

    r = await req("GET", `/api/shops?owner=${FAKE_ID}`);
    check("an id that doesn't exist → [] and 200", r.status === 200 && r.body?.shops?.length === 0);

    r = await req("GET", "/api/shops?owner=abc");
    check("malformed id → 400 Invalid seller id", r.status === 400 && r.body?.error === "Invalid seller id");

    r = await req("GET", `/api/shops?owner=${seller._id}&deliversTo=${khanYounis.id}`);
    check("combines with ?deliversTo= → only Shop A", r.status === 200 && r.body?.shops?.length === 1 && r.body.shops[0].name === "Shop A");

    r = await req("GET", `/api/shops?owner=${seller._id}&deliversTo=${nuseirat.id}`);
    check("...and an area none of theirs covers → []", r.status === 200 && r.body?.shops?.length === 0);

    // ============ Delivery at checkout (Step 13, slice 13.2) ============
    console.log("\nPOST /api/orders with deliveryMethod");
    // Zones right now: shopA → Khan Younis ₪3 · shopB → Rimal ₪0
    //                  otherShop → Khan Younis ₪7
    // orderListingA lives in shopA; orderListingB lives in otherShop.

    // Every order placed before this feature must still read correctly.
    r = await req("GET", `/api/orders/${shopAOrderId}`, { token: orderCustomerToken });
    check("orders created before delivery existed default to pickup", r.body?.order?.deliveryMethod === "pickup");
    check("...with fee 0 and no address (no migration needed)", r.body?.order?.deliveryFee === 0 && r.body?.order?.deliveryAddress === null);

    // Omitting deliveryMethod still means pickup.
    await addToCart(orderCustomerToken, orderListingA.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    check("omitting deliveryMethod → pickup, fee 0", r.status === 201 && r.body?.orders?.[0]?.deliveryMethod === "pickup" && r.body.orders[0].deliveryFee === 0);
    check("pickup total still equals subtotal", r.body?.orders?.[0]?.total === r.body?.orders?.[0]?.subtotal);

    // A delivery order needs somewhere to go.
    await addToCart(orderCustomerToken, orderListingA.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599", deliveryMethod: "delivery" },
    });
    check("delivery with no address → 400", r.status === 400 && r.body?.error === "Delivery address is required");

    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599", deliveryMethod: "delivery", address: { area: "abc" } },
    });
    check("malformed area id → 400", r.status === 400 && r.body?.error === "Invalid area id");

    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599", deliveryMethod: "delivery", address: { area: FAKE_ID } },
    });
    check("unknown area → 400 Area not found", r.status === 400 && r.body?.error === "Area not found");

    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599", deliveryMethod: "teleport", address: { area: khanYounis.id } },
    });
    check("bogus deliveryMethod → 400", r.status === 400);

    // shopA covers Khan Younis (₪3) but NOT Rimal.
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: {
        contactPhone: "0599",
        deliveryMethod: "delivery",
        address: { area: rimal.id, details: "Al-Wehda St" },
      },
    });
    check("shop doesn't cover that area → 409 with both names", r.status === 409 && r.body?.error === "Shop A does not deliver to Rimal");

    // The whole checkout was rejected, so the cart is untouched and retryable.
    r = await req("GET", "/api/cart", { token: orderCustomerToken });
    check("a rejected checkout leaves the cart intact", r.body?.cart?.items?.length === 1);

    // --- the happy path: delivery to an area the shop DOES cover ---
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: {
        contactPhone: "0599",
        deliveryMethod: "delivery",
        address: { area: khanYounis.id, details: "Building 12, 3rd floor" },
      },
    });
    const deliveryOrder = r.body?.orders?.[0];
    const deliveryOrderId = deliveryOrder?._id;
    check("delivery to a covered area → 201", r.status === 201);
    check("deliveryMethod recorded", deliveryOrder?.deliveryMethod === "delivery");
    check("fee resolved from the SHOP's zone (₪3)", deliveryOrder?.deliveryFee === 3);
    // NOTE the price is 99, not 10: the frozen-price section above raised this
    // listing to ₪99. That's the point — the ORDER froze 10, the LISTING moved on.
    check("total = subtotal + fee (99 + 3 = 102)", deliveryOrder?.subtotal === 99 && deliveryOrder?.total === 102);
    check("address stored with the area populated", deliveryOrder?.deliveryAddress?.area?.name === "Khan Younis");
    check("...and the free-text details kept", deliveryOrder?.deliveryAddress?.details === "Building 12, 3rd floor");

    // A fee of 0 is a real answer — free delivery — not "doesn't deliver".
    // shopB covers Rimal at ₪0. Its listing is oosListing... which is out of
    // stock, so give shopB a fresh in-stock listing to order.
    const freeDeliveryListing = await Listing.create({
      shop: shopB._id,
      product: orderProductB._id,
      price: 20,
    });
    await addToCart(orderCustomerToken, freeDeliveryListing.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: {
        contactPhone: "0599",
        deliveryMethod: "delivery",
        address: { area: rimal.id },
      },
    });
    check("₪0 zone means FREE delivery, not 'no delivery' → 201", r.status === 201);
    check("fee 0, total unchanged from subtotal", r.body?.orders?.[0]?.deliveryFee === 0 && r.body?.orders?.[0]?.total === 20);

    // Per-shop fees: one checkout spanning two shops resolves each separately.
    await addToCart(orderCustomerToken, orderListingA.id, 1); // shopA, KY ₪3
    await addToCart(orderCustomerToken, orderListingB.id, 1); // otherShop, KY ₪7
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: {
        contactPhone: "0599",
        deliveryMethod: "delivery",
        address: { area: khanYounis.id },
      },
    });
    const feeByShop = {};
    (r.body?.orders || []).forEach((o) => { feeByShop[o.shop.name] = o.deliveryFee; });
    check("two shops in one checkout → 2 orders", r.body?.orders?.length === 2);
    check("each order carries ITS OWN shop's fee (3 and 7)", feeByShop["Shop A"] === 3 && feeByShop["Other Shop"] === 7);

    // ============ The `delivering` status ============
    console.log("\nPATCH /api/orders/:id/status — the delivering step");

    // On a PICKUP order, `delivering` isn't a move that exists for anyone.
    await addToCart(orderCustomerToken, orderListingA.id, 1);
    r = await req("POST", "/api/orders", {
      token: orderCustomerToken,
      body: { contactPhone: "0599" },
    });
    const pickupOrderId = r.body?.orders?.[0]?._id;
    await req("PATCH", `/api/orders/${pickupOrderId}/status`, { token: sellerToken, body: { status: "accepted" } });
    await req("PATCH", `/api/orders/${pickupOrderId}/status`, { token: sellerToken, body: { status: "ready" } });

    r = await req("PATCH", `/api/orders/${pickupOrderId}/status`, {
      token: sellerToken,
      body: { status: "delivering" },
    });
    check("PICKUP order can't go to delivering → 409", r.status === 409 && r.body?.error === "Cannot change a ready order to delivering");

    r = await req("PATCH", `/api/orders/${pickupOrderId}/status`, {
      token: adminToken,
      body: { status: "delivering" },
    });
    check("...not even for an admin (it's illegal, not forbidden)", r.status === 409);

    r = await req("PATCH", `/api/orders/${pickupOrderId}/status`, {
      token: sellerToken,
      body: { status: "completed" },
    });
    check("a pickup order still goes ready → completed → 200", r.status === 200 && r.body?.order?.status === "completed");

    // On a DELIVERY order, the extra step exists.
    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, { token: sellerToken, body: { status: "accepted" } });
    check("delivery order: pending → accepted", r.status === 200);
    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, { token: sellerToken, body: { status: "ready" } });
    check("delivery order: accepted → ready", r.status === 200);

    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, {
      token: orderCustomerToken,
      body: { status: "delivering" },
    });
    check("the customer can't mark it delivering → 403 (their move, no)", r.status === 403);

    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, {
      token: sellerToken,
      body: { status: "delivering" },
    });
    check("DELIVERY order: ready → delivering → 200", r.status === 200 && r.body?.order?.status === "delivering");

    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, {
      token: sellerToken,
      body: { status: "ready" },
    });
    check("can't go backwards from delivering → 409", r.status === 409);

    r = await req("PATCH", `/api/orders/${deliveryOrderId}/status`, {
      token: sellerToken,
      body: { status: "completed" },
    });
    check("delivering → completed → 200", r.status === 200 && r.body?.order?.status === "completed");

    r = await req("GET", "/api/orders?status=delivering", { token: orderCustomerToken });
    check("?status=delivering is now a valid filter", r.status === 200);

    // ============ Seller dashboard: /api/seller (slice 17.1) ============
    // Its own small world, so the counts below are exact: a new seller with an
    // OPEN shop (two items, one out of stock) and a CLOSED shop (one item), plus
    // one item of the same product at someone else's shop that must never show.
    console.log("\n/api/seller: sellers only (router-level guard)");

    const dashSeller = await User.create({
      name: "Dash Seller",
      email: "dash-seller@test.com",
      passwordHash: "x",
      role: "seller",
    });
    const dashToken = tokenFor(dashSeller);
    const dashArea = await Area.create({ name: "Dash Area", nameAr: "منطقة", slug: "dash-area" });
    const dashOpenShop = await Shop.create({
      owner: dashSeller._id,
      name: "Dash Open",
      phone: "10",
      category: category._id,
      deliveryZones: [{ area: dashArea._id, fee: 5 }],
    });
    const dashClosedShop = await Shop.create({
      owner: dashSeller._id,
      name: "Dash Closed",
      phone: "11",
      isActive: false,
    });
    const [dashP1, dashP2, dashP3] = await Product.create([
      { name: "Dash Rice", nameAr: "أرز", category: category._id },
      { name: "Dash Oil", nameAr: "زيت", category: category._id },
      { name: "Dash Tea", nameAr: "شاي", category: category._id },
    ]);
    // Created one at a time, so "newest first" is a known order: P3, P2, P1.
    await Listing.create({ shop: dashOpenShop._id, product: dashP1._id, price: 10 });
    await Listing.create({ shop: dashOpenShop._id, product: dashP2._id, price: 20, inStock: false });
    const dashClosedListing = await Listing.create({ shop: dashClosedShop._id, product: dashP3._id, price: 30 });
    const notMineListing = await Listing.create({ shop: otherShop._id, product: dashP1._id, price: 11 });

    r = await req("GET", "/api/seller/shops");
    check("no token → 401", r.status === 401);
    r = await req("GET", "/api/seller/shops", { token: customerToken });
    check("a customer → 403", r.status === 403);
    r = await req("GET", "/api/seller/shops", { token: adminToken });
    check("an admin → 403 (admins use /api/admin)", r.status === 403);
    r = await req("GET", "/api/seller/nothing-here", { token: customerToken });
    check("even an unknown /api/seller path → 403 for a non-seller", r.status === 403);

    console.log("\nGET /api/seller/shops (my shops)");
    r = await req("GET", "/api/seller/shops", { token: dashToken });
    const myShops = r.body?.shops || [];
    check("200 with exactly my 2 shops", r.status === 200 && myShops.length === 2);
    check("oldest first (the sign-up shop comes first)", myShops[0]?.name === "Dash Open" && myShops[1]?.name === "Dash Closed");
    check("the CLOSED shop is included (the public list hides it)", myShops[1]?.isActive === false);
    check("another seller's shop never appears", !myShops.some((s) => s.name === "Other Shop"));
    check("delivery zones come with the area's name", myShops[0]?.deliveryZones?.[0]?.area?.name === "Dash Area" && myShops[0].deliveryZones[0].fee === 5);
    check("the category is populated", myShops[0]?.category?.name === "Grocery");
    check("isVerified is there for the dashboard badge", myShops[0]?.isVerified === false);

    r = await req("GET", "/api/seller/shops", { token: tokenFor(shoplessSeller) });
    check("a seller with no shops → [] and 200 (not an error)", r.status === 200 && Array.isArray(r.body?.shops) && r.body.shops.length === 0);

    console.log("\nGET /api/seller/listings (my items)");
    r = await req("GET", "/api/seller/listings", { token: dashToken });
    let myItems = r.body?.listings || [];
    check("paginated shape { listings, page, limit, total }", r.status === 200 && r.body?.page === 1 && typeof r.body?.limit === "number");
    check("all 3 of my items, across both shops", r.body?.total === 3 && myItems.length === 3);
    check("newest first", myItems.map((l) => l.product?.name).join(",") === "Dash Tea,Dash Oil,Dash Rice");
    check("the closed shop's item is included, marked closed", myItems[0]?._id === dashClosedListing._id.toString() && myItems[0]?.shop?.isActive === false);
    check("each item shows its shop's name", myItems[1]?.shop?.name === "Dash Open");
    check("each item shows its product", myItems[1]?.product?.nameAr === "زيت" && typeof myItems[1]?.product?.imageUrl === "string");
    check("the same product at someone else's shop never shows", !myItems.some((l) => l._id === notMineListing._id.toString()));

    r = await req("GET", `/api/seller/listings?shop=${dashOpenShop._id}`, { token: dashToken });
    check("?shop= one of my shops → only its 2 items", r.status === 200 && r.body?.total === 2 && r.body.listings.every((l) => l.shop?.name === "Dash Open"));

    r = await req("GET", `/api/seller/listings?shop=${dashClosedShop._id}`, { token: dashToken });
    check("?shop= my CLOSED shop works too", r.status === 200 && r.body?.total === 1);

    r = await req("GET", `/api/seller/listings?shop=${otherShop._id}`, { token: dashToken });
    check("?shop= someone else's shop → 403", r.status === 403);

    r = await req("GET", "/api/seller/listings?shop=banana", { token: dashToken });
    check("?shop= malformed → 400 Invalid shop id", r.status === 400 && r.body?.error === "Invalid shop id");

    r = await req("GET", "/api/seller/listings?inStock=false", { token: dashToken });
    check("?inStock=false → only the out-of-stock item", r.status === 200 && r.body?.total === 1 && r.body.listings[0]?.product?.name === "Dash Oil");

    r = await req("GET", "/api/seller/listings?inStock=true", { token: dashToken });
    check("?inStock=true → the 2 in-stock items", r.status === 200 && r.body?.total === 2);

    r = await req("GET", "/api/seller/listings?inStock=yes", { token: dashToken });
    check("?inStock=yes → 400", r.status === 400 && r.body?.error === "inStock must be true or false");

    r = await req("GET", `/api/seller/listings?shop=${dashOpenShop._id}&inStock=true`, { token: dashToken });
    check("?shop and ?inStock combine", r.status === 200 && r.body?.total === 1 && r.body.listings[0]?.product?.name === "Dash Rice");

    r = await req("GET", "/api/seller/listings?limit=1&page=2", { token: dashToken });
    check("pagination: page 2 of 1-per-page is the 2nd newest, total unchanged", r.status === 200 && r.body?.listings?.length === 1 && r.body.listings[0]?.product?.name === "Dash Oil" && r.body?.total === 3);

    r = await req("GET", "/api/seller/listings", { token: tokenFor(shoplessSeller) });
    check("a seller with no shops → empty page, 200", r.status === 200 && r.body?.total === 0);

    // ===== Static product images (served by express.static, not a controller) =====
    // We call fetch directly instead of req(), because req() expects a JSON body
    // and an image is binary.
    console.log("\nGET /images/products/:file (static images)");

    let img = await fetch(base + "/images/products/headphones.webp");
    check("an existing image → 200", img.status === 200);
    check("...served as image/webp", img.headers.get("content-type") === "image/webp");
    check(
      "...with a 7-day browser cache header",
      (img.headers.get("cache-control") || "").includes("max-age=604800")
    );
    const bytes = (await img.arrayBuffer()).byteLength;
    check("...and actual file bytes in the body", bytes > 0);

    img = await fetch(base + "/images/products/does-not-exist.webp");
    check("a missing image → 404 (falls through to the JSON 404 handler)", img.status === 404);

    // %2e%2e is an encoded "..". A plain "../" would be tidied away by fetch
    // itself before it ever reached the server, so it wouldn't test anything.
    img = await fetch(base + "/images/%2e%2e/app.js");
    check("can't escape the images folder with ../ → not 200", img.status !== 200);
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
