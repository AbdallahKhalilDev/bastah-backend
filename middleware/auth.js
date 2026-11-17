const jwt = require("jsonwebtoken");
const User = require("../models/User");

// AUTHENTICATION middleware — answers "WHO are you?"
//
// Put this in front of any route that requires a logged-in user. It reads the
// token the client sends, verifies it's genuine, checks the account behind it,
// and attaches the user's identity to `req` so the controller can use it.
//
// 401 (Unauthorized) here means "I don't know who you are" — no token, or a
// token I can't trust. (Compare with 403 in requireRole.js: "I know you, but
// you're not allowed.")
//
// It's `async` now, because it reads the database. Express 4 doesn't catch
// errors from async functions by itself, so the database part is wrapped in
// try/catch and any error goes to next(err), and from there to the central
// error handler.
async function auth(req, res, next) {
  // 1. Clients send: `Authorization: Bearer <token>`. Split off the token part.
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next({ status: 401, message: "Not authenticated" });
  }

  // 2. jwt.verify does two jobs at once: checks the signature (proves WE signed
  //    it, so it wasn't forged or tampered with) AND checks it hasn't expired.
  //    If either fails it throws, and we answer 401.
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return next({ status: 401, message: "Invalid or expired token" });
  }

  try {
    // 3. NEW: look the account up in the DATABASE instead of trusting what the
    //    token says. A token is a snapshot from the moment of login and can be
    //    up to 7 days old; the database is the truth RIGHT NOW. This is one fast
    //    lookup by _id, and we fetch only the two fields we need.
    const user = await User.findById(payload.id).select("role tokenVersion");

    // 4. The account was deleted after the token was made → not valid any more.
    if (!user) {
      return next({ status: 401, message: "Invalid or expired token" });
    }

    // 5. The password was changed after this token was made, so its counter is
    //    behind (see tokenVersion in models/User.js) → this device must log in
    //    again. Tokens made before the counter existed carry no number at all;
    //    `?? 0` treats them as 0, the same as an account that never changed its
    //    password, so nobody was logged out by this update.
    if ((payload.tokenVersion ?? 0) !== user.tokenVersion) {
      return next({
        status: 401,
        message: "Your password was changed. Please log in again",
      });
    }

    // 6. Attach a small, known shape. The role comes from the DATABASE, so a
    //    role change counts on the very next request.
    req.user = { id: user._id.toString(), role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = auth;
