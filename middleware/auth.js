const jwt = require("jsonwebtoken");

// AUTHENTICATION middleware — answers "WHO are you?"
//
// Put this in front of any route that requires a logged-in user. It reads the
// token the client sends, verifies it's genuine, and attaches the user's
// identity to `req` so the controller can use it.
//
// 401 (Unauthorized) here means "I don't know who you are" — no token, or a
// token I can't trust. (Compare with 403 in requireRole.js: "I know you, but
// you're not allowed.")
function auth(req, res, next) {
  // Clients send: `Authorization: Bearer <token>`. Split off the token part.
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next({ status: 401, message: "Not authenticated" });
  }

  try {
    // jwt.verify does two jobs at once: checks the signature (proves WE signed
    // it, so it wasn't forged or tampered with) AND checks it hasn't expired.
    // If either fails it throws, and we fall into the catch below.
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Trust only what's inside the verified token. Attach a small, known shape.
    req.user = { id: payload.id, role: payload.role };
    next();
  } catch (err) {
    return next({ status: 401, message: "Invalid or expired token" });
  }
}

module.exports = auth;
