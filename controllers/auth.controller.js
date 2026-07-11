const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const User = require("../models/User");

// --- Input validation ---------------------------------------------------
// zod describes exactly what a valid request body looks like. If the incoming
// data doesn't match, we reject it early with a 400 — controllers below can
// then trust the data is well-formed.
const registerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("A valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  phone: z.string().min(1, "Phone is required"),
});

// For login we only need email + password. We keep the rules light on purpose:
// login should not tell the user "password too short" — it just checks the
// credentials and gives one generic answer either way (see below).
const loginSchema = z.object({
  email: z.string().email("A valid email is required"),
  password: z.string().min(1, "Password is required"),
});

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

  // 4. Create the user and respond 201 (Created) with the safe fields only.
  const user = await User.create({ name, email, phone, passwordHash });
  res.status(201).json({ user: publicUser(user) });
}

// POST /api/auth/login
async function login(req, res, next) {
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

  // 4. Success: sign a JWT. The "payload" ({ id, role }) is data baked into
  //    the token; JWT_SECRET signs it so nobody can forge or tamper with it.
  //    The client sends this token back on future requests to prove identity.
  const token = jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );

  res.json({ token });
}

module.exports = { register, login, publicUser };
