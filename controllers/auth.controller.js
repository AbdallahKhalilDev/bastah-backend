const bcrypt = require("bcrypt");
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

module.exports = { register, publicUser };
