const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { z } = require("zod");
const User = require("../models/User");
const Shop = require("../models/Shop");
const parsePagination = require("../utils/pagination");
const escapeRegex = require("../utils/escapeRegex");
const { signupShopSchema, createShopFor } = require("../utils/shopRules");
const { lockSellerShops, unlockSellerShops } = require("../utils/shopLocks");
const {
  ROLES,
  STATUSES,
  accountSchema,
  newPasswordRule,
  publicUser,
  createAccount,
} = require("../utils/accounts");

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

// An admin edits someone's details: name, email, phone, with the same rules as
// at sign-up. `.pick()` takes those three rules from accountSchema, `.partial()`
// makes each optional (a PATCH changes only what you send). role / status /
// password in the body are silently dropped: each has its own endpoint, or
// (for role) none at all.
const updateUserSchema = accountSchema
  .pick({ name: true, email: true, phone: true })
  .partial();

// An admin sets a new password for someone. Same rules as any new password.
const setPasswordSchema = z.object({ newPassword: newPasswordRule });

// An admin switches an account off or back on. The reason is shown to the
// user when they're refused, so it has a length limit like every text field.
const setStatusSchema = z.object({
  status: z.enum(STATUSES, { error: "Status must be active or suspended" }),
  reason: z.string().trim().max(500, "Reason is too long (max 500 characters)").optional(),
});

// --- Shared helpers ------------------------------------------------------

// What an ADMIN sees about an account: the public fields, plus the status
// details (why and when it was suspended, and by which admin) that the user's
// own screens don't need.
function adminUser(user) {
  return {
    ...publicUser(user),
    statusReason: user.statusReason,
    statusChangedAt: user.statusChangedAt,
    statusChangedBy: user.statusChangedBy,
  };
}

// Loads the account named in the URL (/users/:id). Returns { problem } for a
// malformed id (400) or an unknown one (404), otherwise { user }. Four
// endpoints below need exactly this, so it's written once.
async function loadUser(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return { problem: { status: 400, message: "Invalid user id" } };
  }
  const user = await User.findById(id);
  if (!user) {
    return { problem: { status: 404, message: "User not found" } };
  }
  return { user };
}

// Is the admin acting on their OWN account? (Both ids as strings to compare.)
function isSelf(req, user) {
  return user._id.toString() === req.user.id;
}

// --- Endpoints -----------------------------------------------------------

// GET /api/admin/users?role=&status=&q=&page=&limit=
// Every account, newest first, paginated. Optional filters:
//   ?role=customer|seller|admin   only that kind of account
//   ?status=active|suspended      only accounts in that state
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

  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) {
      return next({ status: 400, message: "Invalid status" });
    }
    // CAREFUL: accounts made before `status` existed have NOTHING stored.
    // Mongoose fills in "active" when it LOADS a document, but a query filter
    // runs inside MongoDB, which never sees that default. So "active" must
    // mean "active OR not stored". In MongoDB, `null` also matches a field
    // that is missing, so { $in: ["active", null] } says exactly that.
    filter.status =
      req.query.status === "active" ? { $in: ["active", null] } : req.query.status;
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

  res.json({ users: users.map(adminUser), page, limit, total });
}

// GET /api/admin/users/:id
// One account, for the admin's "user details" screen. For a seller it also
// lists ALL their shops, including hidden ones (the public lists hide those),
// so the admin sees everything that seller runs.
async function getUser(req, res, next) {
  const { problem, user } = await loadUser(req.params.id);
  if (problem) {
    return next(problem);
  }

  const shops =
    user.role === "seller"
      ? await Shop.find({ owner: user._id })
          .select("name area phone isActive isVerified lock createdAt")
          .sort({ createdAt: 1 })
      : [];

  res.json({ user: adminUser(user), shops });
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
  res.status(201).json({ user: adminUser(user), shop });
}

// PATCH /api/admin/users/:id
// An admin fixes someone's name, email and/or phone (any account, other admins
// and themselves included). This is the ONLY way an email changes: users can't
// change their own, because it's their login and we can't verify a new one.
async function updateUser(req, res, next) {
  const result = updateUserSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const data = result.data;

  const { problem, user } = await loadUser(req.params.id);
  if (problem) {
    return next(problem);
  }

  // A new email must not belong to ANOTHER account (one email = one account).
  // `_id: { $ne: ... }` leaves this account itself out, so re-sending its own
  // email (even in different capitals) is not a clash. If two admins race for
  // the same email, the unique index still stops the second one (→ 409 from
  // the central error handler).
  if (data.email) {
    const taken = await User.exists({
      email: data.email.toLowerCase(),
      _id: { $ne: user._id },
    });
    if (taken) {
      return next({ status: 409, message: "Email already registered" });
    }
  }

  // Changing the email does NOT log the user out: their tokens hold their id,
  // not their email. From now on they log in with the new email.
  Object.assign(user, data);
  await user.save();

  res.json({ user: adminUser(user) });
}

// PATCH /api/admin/users/:id/password
// An admin sets a new password for someone, e.g. a user who forgot theirs.
// Until the app can send emails or SMS, this IS "forgot password": the user
// contacts an admin, the admin sets a temporary password and tells them, and
// the user changes it from their account settings.
async function setUserPassword(req, res, next) {
  const result = setPasswordSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }

  const { problem, user } = await loadUser(req.params.id);
  if (problem) {
    return next(problem);
  }

  // Your OWN password goes through PATCH /api/auth/me/password, which asks for
  // the current one. Otherwise anyone who found an admin's unlocked laptop
  // could change that admin's password without knowing it.
  if (isSelf(req, user)) {
    return next({
      status: 403,
      message: "Change your own password from your account settings",
    });
  }

  // New hash, and +1 on the token counter: every device that user is logged in
  // on is logged out (see tokenVersion in models/User.js). Useful when the
  // reason for the reset is that someone else got into the account.
  user.passwordHash = await bcrypt.hash(result.data.newPassword, 10);
  user.tokenVersion += 1;
  await user.save();

  // No token here: this token would belong to the USER, not the admin.
  res.json({ user: adminUser(user) });
}

// PATCH /api/admin/users/:id/status
// An admin suspends an account, or switches it back on. Works for customers,
// sellers AND other admins, but never on yourself: otherwise the last admin
// could lock everyone out of the admin area for good.
async function setUserStatus(req, res, next) {
  const result = setStatusSchema.safeParse(req.body);
  if (!result.success) {
    const message = result.error.issues[0].message;
    return next({ status: 400, message });
  }
  const { status, reason } = result.data;

  // The user sees the reason when they're refused, so suspending needs one.
  if (status === "suspended" && !reason) {
    return next({ status: 400, message: "A reason is required to suspend an account" });
  }

  const { problem, user } = await loadUser(req.params.id);
  if (problem) {
    return next(problem);
  }

  if (isSelf(req, user)) {
    return next({ status: 403, message: "You can't change your own status" });
  }

  // Already in that state → 409 (a "conflict" with the current state), the
  // same idea as an illegal order status move. Most often it means two admins
  // acted at once, and the screen just needs a refresh.
  if (user.status === status) {
    return next({ status: 409, message: `Account is already ${status}` });
  }

  // Record the change: the new state, the reason (cleared when switching the
  // account back on), when, and which admin did it.
  user.status = status;
  user.statusReason = status === "suspended" ? reason : null;
  user.statusChangedAt = new Date();
  user.statusChangedBy = req.user.id;
  await user.save();

  // From the very next request, `auth` refuses this account (it reads the
  // status every time).
  //
  // A suspended SELLER can't log in to answer orders, so their shops must stop
  // taking them: suspending locks every shop of theirs, and switching them back
  // on unlocks only the shops the suspension locked (a shop an admin locked by
  // hand stays locked). The rules are in utils/shopLocks.js.
  // Both counts are always in the reply (0 for customers and admins), so the
  // screen can say "3 shops were closed too".
  let shopsLocked = 0;
  let shopsUnlocked = 0;
  if (user.role === "seller") {
    if (status === "suspended") {
      shopsLocked = await lockSellerShops(user._id, req.user.id);
    } else {
      shopsUnlocked = await unlockSellerShops(user._id);
    }
  }

  res.json({ user: adminUser(user), shopsLocked, shopsUnlocked });
}

// POST /api/admin/users/:id/shops
// An admin adds a shop FOR this seller. The body is exactly what a seller sends
// to POST /api/shops, and it goes through the very same createShopFor(), so
// the same rules apply. The difference is only WHO the owner is: here it's the
// seller named in the URL, not the caller.
// Only sellers own shops: a customer or an admin here is a 400.
async function createUserShop(req, res, next) {
  const { problem, user } = await loadUser(req.params.id);
  if (problem) {
    return next(problem);
  }

  if (user.role !== "seller") {
    return next({ status: 400, message: "Only a seller can own a shop" });
  }

  const created = await createShopFor(user._id, req.body);
  if (created.problem) {
    return next(created.problem);
  }

  res.status(201).json({ shop: created.shop });
}

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserPassword,
  setUserStatus,
  createUserShop,
};
