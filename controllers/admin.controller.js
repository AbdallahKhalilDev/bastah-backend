const mongoose = require("mongoose");
const { z } = require("zod");
const User = require("../models/User");
const Shop = require("../models/Shop");
const parsePagination = require("../utils/pagination");
const escapeRegex = require("../utils/escapeRegex");
const { signupShopSchema } = require("../utils/shopRules");
const { ROLES, accountSchema, publicUser, createAccount } = require("../utils/accounts");

// Every route in this file is admin-only. That's enforced ONCE, in
// routes/admin.routes.js (router.use(auth, requireRole("admin"))), so none of
// the functions below repeat the check.

// --- Input validation ---------------------------------------------------
// An admin creates an account: the same fields as any sign-up, plus the role,
// which the ADMIN chooses (unlike a sign-up, where the URL decides it). A seller
// also needs their first shop, exactly like seller sign-up, so that every seller
// starts with a shop no matter who created the account.
const createUserSchema = accountSchema.extend({
  role: z.enum(ROLES, { error: "Role must be customer, seller or admin" }),
  shop: signupShopSchema.optional(),
});

// GET /api/admin/users?role=&q=&page=&limit=
// Every account, newest first, paginated. Optional filters:
//   ?role=customer|seller|admin   only that kind of account
//   ?q=text                       name, email or phone contains this text
async function listUsers(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  // A role that doesn't exist is a mistake worth reporting (same as ?status=
  // on orders), not something to quietly ignore.
  if (req.query.role) {
    if (!ROLES.includes(req.query.role)) {
      return next({ status: 400, message: "Invalid role" });
    }
    filter.role = req.query.role;
  }

  // Search: "contains", ignoring capitals. escapeRegex makes characters like
  // "(" or "+" match literally instead of breaking the search (the same helper
  // the product and global search use).
  const q = String(req.query.q || "").trim();
  if (q) {
    const pattern = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }];
  }

  // The page and the total count run side by side; neither needs the other.
  // "-passwordHash" leaves the hash out of what we even read from the database.
  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-passwordHash")
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.json({ users: users.map(publicUser), page, limit, total });
}

// GET /api/admin/users/:id
// One account, for the admin's "user details" screen. For a seller it also
// lists ALL their shops, including hidden ones (the public lists hide those),
// so the admin sees everything that seller runs.
async function getUser(req, res, next) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next({ status: 400, message: "Invalid user id" });
  }

  const user = await User.findById(req.params.id).select("-passwordHash");
  if (!user) {
    return next({ status: 404, message: "User not found" });
  }

  const shops =
    user.role === "seller"
      ? await Shop.find({ owner: user._id })
          .select("name area phone isActive isVerified createdAt")
          .sort({ createdAt: 1 })
      : [];

  res.json({ user: publicUser(user), shops });
}

// POST /api/admin/users
// An admin creates an account of ANY role, active at once. This is also the
// ONLY way a new admin is made once the first one exists (there's no admin
// sign-up page).
async function createUser(req, res, next) {
  // 1. Validate. A missing or unknown role → 400.
  const result = createUserSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  // 2. Create it the one shared way (utils/accounts.js). Only a seller gets a
  //    shop: a shop sent along for a customer or an admin is ignored. A seller
  //    WITHOUT a shop gets "Shop details are required" from createAccount.
  const { problem, user, shop } = await createAccount({
    ...data,
    shop: data.role === "seller" ? data.shop : undefined,
  });
  if (problem) {
    return next(problem);
  }

  // 3. 201 with the new account (and the shop, or null). NO token: the admin
  //    stays logged in as themselves. The new person logs in on their own page
  //    with the password the admin gives them, and can then change it.
  res.status(201).json({ user: publicUser(user), shop });
}

module.exports = { listUsers, getUser, createUser };
