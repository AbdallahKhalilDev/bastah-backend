// AUTHORIZATION middleware — answers "are you ALLOWED to do this?"
//
// Use it AFTER the `auth` middleware (auth sets req.user; this checks the role).
// It's a "middleware factory": you call it with the roles you want to permit,
// and it returns the actual middleware. Example on a route:
//
//   router.post("/shops", auth, requireRole("seller", "admin"), createShop)
//
// 403 (Forbidden) means "I know exactly who you are, but your role isn't
// allowed here." That's different from 401 (in auth.js), which means "I don't
// know who you are at all." Rule of thumb:
//   401 = not logged in / bad token   → log in
//   403 = logged in, but wrong role   → logging in again won't help
function requireRole(...allowedRoles) {
  return function (req, res, next) {
    // auth must have run first; if not, there's no identity to check.
    if (!req.user) {
      return next({ status: 401, message: "Not authenticated" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next({ status: 403, message: "Forbidden" });
    }

    next();
  };
}

module.exports = requireRole;
