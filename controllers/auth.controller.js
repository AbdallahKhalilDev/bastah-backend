const bcrypt = require("bcrypt");
const { z } = require("zod");
const User = require("../models/User");
const { signupShopSchema } = require("../utils/shopRules");
const {
  accountSchema,
  newPasswordRule,
  signToken,
  publicUser,
  suspendedError,
  createAccount,
} = require("../utils/accounts");

// --- Input validation ---------------------------------------------------
// zod describes exactly what a valid request body looks like. If the incoming
// data doesn't match, we reject it early with a 400 — controllers below can
// then trust the data is well-formed.
//
// The rules for a NEW account (accountSchema: name, email, password, phone) live
// in utils/accounts.js, because admins create accounts too (admin.controller.js)
// and both must follow the very same rules.

// PATCH /api/auth/me: a user may change their name and phone. `.pick()` takes
// just those two rules from accountSchema (so the limits stay identical), and
// `.partial()` makes both optional, because a PATCH changes only what you send.
// Email and role are NOT in this whitelist, so they're silently dropped: the
// email is the login id, and the role never changes.
const updateMeSchema = accountSchema.pick({ name: true, phone: true }).partial();

// PATCH /api/auth/me/password. The current password is only compared with the
// stored hash, so it gets no length rules (an older account may have a longer
// one). The new password follows the same rules as at sign-up.
const changePasswordSchema = z.object({
  currentPassword: z
    .string({ error: "Current password is required" })
    .min(1, "Current password is required"),
  newPassword: newPasswordRule,
});

// Seller sign-up = the SAME account fields as a customer, plus a `shop` object
// holding their first shop. `.extend()` copies accountSchema and adds the extra
// key, so the account rules exist in one place only. The shop part follows the
// shared shop rules (utils/shopRules.js).
const registerSellerSchema = accountSchema.extend({
  shop: signupShopSchema,
});

// For login we only need email + password. We keep the rules light on purpose:
// login should not tell the user "password too short" — it just checks the
// credentials and gives one generic answer either way (see below).
// Note: NO 72-byte limit here. An account made before that limit existed may
// have a longer password, and it must still be able to log in.
const loginSchema = z.object({
  email: z
    .string({ error: "Email is required" })
    .trim()
    .max(254, "Email is too long")
    .email("A valid email is required"),
  password: z
    .string({ error: "Password is required" })
    .min(1, "Password is required"),
});

// POST /api/auth/register  (a customer signs up)
async function register(req, res, next) {
  // 1. Validate the body. `safeParse` doesn't throw — it returns success/error
  //    so we can craft our own 400 response with a readable message. A `role`
  //    in the body is silently dropped: this URL always makes a customer.
  const result = accountSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }

  // 2. Create the account the one shared way (utils/accounts.js): it checks
  //    the email is free, hashes the password, and saves.
  const { problem, user } = await createAccount({ ...result.data, role: "customer" });
  if (problem) {
    return next(problem);
  }

  // 3. Respond 201 (Created) with the safe fields AND a token, so the new user
  //    is logged in straight away instead of having to log in a second time.
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
}

// POST /api/auth/seller/register
// A new seller signs up AND creates their first shop in one form, so they can
// enter the shop's location and details right away instead of in a second step.
// More shops can be added later from the dashboard (POST /api/shops).
async function registerSeller(req, res, next) {
  // 1. Validate the account fields AND the shop fields together. Any problem in
  //    either → 400 before anything is saved. Unknown keys (role, and owner /
  //    isVerified / ratingAvg / isActive inside `shop`) are silently dropped.
  const result = registerSellerSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }

  // 2. Create the seller AND their shop the one shared way (utils/accounts.js).
  //    It checks everything before saving anything, and never leaves a seller
  //    without their shop.
  const { problem, user, shop } = await createAccount({ ...result.data, role: "seller" });
  if (problem) {
    return next(problem);
  }

  // 3. 201 with the user, a token (they're logged in at once, like customers),
  //    and the new shop, so the dashboard can open straight onto it.
  res.status(201).json({ user: publicUser(user), token: signToken(user), shop });
}

// The LOGIN FACTORY — one login logic, one endpoint per login page.
//
// Customers, sellers and admins each have their own login page, and an account
// has exactly ONE role. So each page gets its own endpoint that accepts only its
// own kind of account:
//
//   POST /api/auth/login         → loginAs("customer")
//   POST /api/auth/seller/login  → loginAs("seller")
//   POST /api/auth/admin/login   → loginAs("admin")
//
// It's the same "factory" idea as requireRole("seller"): you call loginAs with a
// role, and it RETURNS the actual handler, which remembers that role. All three
// pages share the code below, so they can never drift apart.
function loginAs(role) {
  return async function login(req, res, next) {
    // 1. Validate shape (must have an email and a non-empty password).
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues[0].message;
      return next({ status: 400, message });
    }
    const { email, password } = result.data;

    // 2. Look up the user. IMPORTANT: whether the email is unknown OR the
    //    password is wrong, we answer with the SAME generic 401. Revealing
    //    "no such email" vs "wrong password" would let an attacker discover
    //    which emails have accounts.
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return next({ status: 401, message: "Invalid email or password" });
    }

    // 3. bcrypt.compare re-hashes the given password and checks it against the
    //    stored hash. It returns true only if they match.
    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return next({ status: 401, message: "Invalid email or password" });
    }

    // 4. Right password, but the WRONG login page (e.g. a customer account on
    //    the seller page). This check comes AFTER the password on purpose: a
    //    stranger guessing passwords only ever sees the 401 above, so this
    //    message can't be used to find out what kind of account an email has.
    //
    //    403 = "I know who you are, but not here". `code` is a short, fixed
    //    label the app can match on to show its own (Arabic) text and a link
    //    to the right page, instead of matching our English sentence.
    if (user.role !== role) {
      const article = role === "admin" ? "an" : "a";
      return next({
        status: 403,
        message: `This is not ${article} ${role} account`,
        code: "wrong_portal",
      });
    }

    // 5. An admin suspended this account → no token. Like step 4, this comes
    //    after the password check, so only the real owner ever learns that the
    //    account is suspended, and why.
    if (user.status === "suspended") {
      return next(suspendedError(user));
    }

    // 6. Success: send the token AND the user's safe fields. With `user.role`
    //    in the answer, the app knows at once which screens to open, with no
    //    second request to /me.
    res.json({ token: signToken(user), user: publicUser(user) });
  };
}

// GET /api/auth/me  (protected by the `auth` middleware)
async function me(req, res, next) {
  // `auth` already verified the token and set req.user = { id, role }.
  // We reload from the DB so the response reflects the user's CURRENT data
  // (e.g. if their name/phone changed since the token was issued).
  const user = await User.findById(req.user.id);
  if (!user) {
    return next({ status: 404, message: "User not found" });
  }

  // Same safe shape as register — never expose passwordHash.
  res.json({ user: publicUser(user) });
}

// PATCH /api/auth/me  (any logged-in user: customer, seller or admin)
// Change your own name and/or phone. Only the fields you send change.
async function updateMe(req, res, next) {
  // 1. Validate against the whitelist. email / role / passwordHash in the body
  //    are silently dropped, so this can never change them.
  const result = updateMeSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }

  // 2. Load the account. `auth` has just checked it exists, but it could be
  //    deleted between the two lookups, so we still handle "not found".
  const user = await User.findById(req.user.id);
  if (!user) {
    return next({ status: 404, message: "User not found" });
  }

  // 3. Copy the validated fields on and save. An empty body changes nothing
  //    and simply returns the account as it is.
  Object.assign(user, result.data);
  await user.save();

  res.json({ user: publicUser(user) });
}

// PATCH /api/auth/me/password  (any logged-in user)
// Change your own password. You must know the current one: a token alone isn't
// enough, so someone who picks up an unlocked phone can't lock the owner out.
async function changePassword(req, res, next) {
  // 1. Validate the body.
  const result = changePasswordSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const { currentPassword, newPassword } = result.data;

  // 2. Load the account (same "not found" note as updateMe).
  const user = await User.findById(req.user.id);
  if (!user) {
    return next({ status: 404, message: "User not found" });
  }

  // 3. Check the current password. Wrong → 400, NOT 401. A 401 means "your
  //    session is invalid", and the app would react by logging the user out,
  //    when all they did was mistype a password in a form.
  const currentMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!currentMatches) {
    return next({ status: 400, message: "Current password is incorrect" });
  }

  // 4. Save the new hash and add 1 to the token counter. Every token issued
  //    before this moment now carries the old number, so `auth` refuses it:
  //    every other phone or browser is logged out.
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.tokenVersion += 1;
  await user.save();

  // 5. Send back a FRESH token carrying the new number, so the device that made
  //    the change stays logged in. The app must replace its stored token.
  res.json({ token: signToken(user), user: publicUser(user) });
}

module.exports = {
  register,
  registerSeller,
  loginAs,
  me,
  updateMe,
  changePassword,
};
