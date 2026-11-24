// Everything about CREATING an account and showing it safely, in one place.
//
// Accounts are born in four places:
//   POST /api/auth/register          a customer signs up
//   POST /api/auth/seller/register   a seller signs up, with their first shop
//   POST /api/admin/users            an admin creates an account of any role
//   npm run create-admin             the script that makes the very first admin
// All four go through createAccount() below, so the rules (one email = one
// account, the password stored only as a hash, a seller always gets a shop) are
// written once and can't differ between them.
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const User = require("../models/User");
const Shop = require("../models/Shop");
const { checkCategory } = require("./shopRules");

// The three kinds of account (must match the enum in models/User.js).
const ROLES = ["customer", "seller", "admin"];

// The two account statuses (must match the enum in models/User.js).
const STATUSES = ["active", "suspended"];

// --- Input rules ---------------------------------------------------------
// Every text field has a MAXIMUM length. Without one, anyone could store a
// 100 KB "name" in our database. `.trim()` runs first, so "  Sara  " is saved as
// "Sara" and a name made only of spaces counts as empty.
//
// `{ error: "..." }` on z.string() is the message for a field that is MISSING
// altogether (without it, zod says "Invalid input: expected string, received
// undefined"). The message in .min(1, "...") is for one that is present but empty.

// bcrypt (our password hasher) only looks at the first 72 BYTES of a password and
// silently ignores the rest. So "a 100-character password" would really be a
// 72-byte one, without the user ever knowing. We refuse longer passwords instead.
// We count BYTES, not letters: an English letter is 1 byte, but an Arabic letter
// is 2, so 72 bytes = 72 English letters, or 36 Arabic ones.
const PASSWORD_MAX_BYTES = 72;

// The rules for ONE new password: at sign-up, when an admin creates an account,
// and for "change my password".
const newPasswordRule = z
  .string({ error: "Password is required" })
  .min(6, "Password must be at least 6 characters")
  .refine(
    (p) => Buffer.byteLength(p, "utf8") <= PASSWORD_MAX_BYTES,
    "Password is too long (max 72 English or 36 Arabic characters)"
  );

// The fields every new account has, whatever its role. There's no `role` here:
// each caller decides the role itself, never the person signing up.
const accountSchema = z.object({
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(1, "Name is required")
    .max(100, "Name is too long (max 100 characters)"),
  email: z
    .string({ error: "Email is required" })
    .trim()
    .max(254, "Email is too long")
    .email("A valid email is required"),
  password: newPasswordRule,
  phone: z
    .string({ error: "Phone is required" })
    .trim()
    .min(1, "Phone is required")
    .max(20, "Phone is too long (max 20 characters)"),
});

// --- Tokens and safe output ------------------------------------------------

// The ONE place a login token is made. The "payload" is data baked into the
// token; JWT_SECRET signs it so nobody can forge or tamper with it. The client
// sends this token back on future requests to prove who it is.
//
// tokenVersion is the account's counter at this moment (see models/User.js).
// The `auth` middleware compares it with the account's CURRENT counter.
function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
}

// Take a User document and return only the safe, public fields.
// This guarantees we NEVER send the passwordHash back to the client.
function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    // The two mute switches, for the profile page. `!== false` means "on unless
    // switched off", so an account with nothing stored shows both on.
    notificationPrefs: {
      offers: user.notificationPrefs?.offers !== false,
      alerts: user.notificationPrefs?.alerts !== false,
    },
    createdAt: user.createdAt,
  };
}

// The error for a suspended account, used by BOTH places that refuse one: the
// login (controllers/auth.controller.js) and every request with an existing
// token (middleware/auth.js). One shared function, so both say exactly the
// same thing.
//   403 = "I know who you are, but you're not allowed in."
//   code "account_suspended" lets the app show its own (Arabic) text and log
//   the user out, instead of matching our English sentence.
function suspendedError(user) {
  return {
    status: 403,
    message: user.statusReason
      ? `This account is suspended: ${user.statusReason}`
      : "This account is suspended",
    code: "account_suspended",
  };
}

// --- Creating an account ---------------------------------------------------

// Creates one account and, for a seller, their first shop.
//
// `data` must ALREADY have passed accountSchema (and, for a seller, the shop
// rules). The caller decides `role`. Returns ONE of two shapes:
//   { problem: { status, message } }  → nothing was saved; pass it to next()
//   { user, shop }                    → saved; `shop` is null unless a seller
// (The same "return the problem" style as checkCategory in shopRules.js.)
//
// The big rule: NEVER leave a seller without their shop. We have no database
// transactions (see the checkout notes in order.controller.js), so we use the
// same approach as checkout: check EVERYTHING first, and only start saving once
// nothing can be wrong with the input.
async function createAccount({ name, email, phone, password, role, shop: shopData }) {
  // 1. A seller must come with a shop, and its category (if any) must be real.
  if (role === "seller") {
    if (!shopData) {
      return { problem: { status: 400, message: "Shop details are required" } };
    }
    const categoryProblem = await checkCategory(shopData.category);
    if (categoryProblem) {
      return { problem: { status: 400, message: categoryProblem } };
    }
  }

  // 2. One email = one account, whatever the role → 409. (Emails are stored
  //    lowercased, so lowercase here too before checking.)
  const existing = await User.exists({ email: email.toLowerCase() });
  if (existing) {
    return { problem: { status: 409, message: "Email already registered" } };
  }

  // 3. Everything checked. Hash the password: bcrypt turns "mypassword" into a
  //    one-way scrambled string; 10 is the "salt rounds" (how much work the hash
  //    takes). We store ONLY this hash, never the real password.
  const passwordHash = await bcrypt.hash(password, 10);

  // 4. Save the user. If two sign-ups with the same email arrive at the very
  //    same moment, both can pass step 2 before either is saved. The database's
  //    unique index then rejects the second one, and the central error handler
  //    turns that into the same 409 (see middleware/errorHandler.js).
  const user = await User.create({ name, email, phone, passwordHash, role });

  if (role !== "seller") {
    return { user, shop: null };
  }

  // 5. Save the seller's shop. If they left the shop phone out, it uses their
  //    own phone. (`??` means "only if it's missing", unlike `||`.)
  //
  //    If saving the shop STILL fails (say the database drops at this exact
  //    moment), we delete the user we just made, then let the error continue
  //    to the error handler. Without this, the email would be taken by a
  //    seller with no shop, and the person couldn't even try again. This
  //    "undo step 4 by hand" is our stand-in for a transaction.
  try {
    const shop = await Shop.create({
      ...shopData,
      phone: shopData.phone ?? phone,
      owner: user._id,
    });
    return { user, shop };
  } catch (err) {
    await User.deleteOne({ _id: user._id });
    throw err;
  }
}

module.exports = {
  ROLES,
  STATUSES,
  newPasswordRule,
  accountSchema,
  signToken,
  publicUser,
  suspendedError,
  createAccount,
};
