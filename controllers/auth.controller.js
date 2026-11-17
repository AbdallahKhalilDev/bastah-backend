const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const User = require("../models/User");

// --- Input validation ---------------------------------------------------
// zod describes exactly what a valid request body looks like. If the incoming
// data doesn't match, we reject it early with a 400 — controllers below can
// then trust the data is well-formed.
//
// Every text field has a MAXIMUM length too. Without one, anyone could store a
// 100 KB "name" in our database. `.trim()` runs first, so "  Sara  " is saved as
// "Sara" and a name made only of spaces counts as empty.

// bcrypt (our password hasher) only looks at the first 72 BYTES of a password and
// silently ignores the rest. So "a 100-character password" would really be a
// 72-byte one, without the user ever knowing. We refuse longer passwords instead.
// We count BYTES, not letters: an English letter is 1 byte, but an Arabic letter
// is 2, so 72 bytes = 72 English letters, or 36 Arabic ones.
const PASSWORD_MAX_BYTES = 72;

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Name is too long (max 100 characters)"),
  email: z
    .string()
    .trim()
    .max(254, "Email is too long")
    .email("A valid email is required"),
  password: z
    .string()
    .min(6, "Password must be at least 6 characters")
    .refine(
      (p) => Buffer.byteLength(p, "utf8") <= PASSWORD_MAX_BYTES,
      "Password is too long (max 72 English or 36 Arabic characters)"
    ),
  phone: z
    .string()
    .trim()
    .min(1, "Phone is required")
    .max(20, "Phone is too long (max 20 characters)"),
});

// For login we only need email + password. We keep the rules light on purpose:
// login should not tell the user "password too short" — it just checks the
// credentials and gives one generic answer either way (see below).
// Note: NO 72-byte limit here. An account made before that limit existed may
// have a longer password, and it must still be able to log in.
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254, "Email is too long")
    .email("A valid email is required"),
  password: z.string().min(1, "Password is required"),
});

// The ONE place a login token is made, so register and login can never drift
// apart. The "payload" ({ id, role }) is data baked into the token; JWT_SECRET
// signs it so nobody can forge or tamper with it. The client sends this token
// back on future requests to prove who it is.
function signToken(user) {
  return jwt.sign(
    { id: user._id, role: user.role },
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
    createdAt: user.createdAt,
  };
}

// POST /api/auth/register
async function register(req, res, next) {
  // 1. Validate the body. `safeParse` doesn't throw — it returns success/error
  //    so we can craft our own 400 response with a readable message.
  const result = registerSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const { name, email, password, phone } = result.data;

  // 2. Reject duplicate emails. (email is stored lowercased, so lowercase here
  //    too before checking.)
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return next({ status: 409, message: "Email already registered" });
  }

  // 3. Hash the password. bcrypt turns "mypassword" into a one-way scrambled
  //    string; 10 is the "salt rounds" (how much work the hash takes).
  //    We store ONLY this hash, never the real password.
  const passwordHash = await bcrypt.hash(password, 10);

  // 4. Create the user. If two sign-ups with the same email arrive at the very
  //    same moment, both can pass step 2 before either is saved. The database's
  //    unique index then rejects the second one, and the central error handler
  //    turns that into the same 409 as step 2 (see middleware/errorHandler.js).
  const user = await User.create({ name, email, phone, passwordHash });

  // 5. Respond 201 (Created) with the safe fields AND a token, so the new user
  //    is logged in straight away instead of having to log in a second time.
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
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

    // 5. Success: send the token AND the user's safe fields. With `user.role`
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

module.exports = { register, loginAs, me, publicUser };
