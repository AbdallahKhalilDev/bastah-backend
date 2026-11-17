// The ONE place every error ends up. Controllers call next({ status, message }),
// and asyncHandler forwards anything thrown. This turns it into a JSON reply.

// MongoDB's own error number for "a unique index already has this value".
// Example: two sign-ups with the same email arriving at the same moment. Both
// pass the controller's "is this email taken?" check, then the database refuses
// the second save. Without this mapping, that would reach the user as a 500
// ("server broke") when it's really a 409 ("that already exists").
const DUPLICATE_KEY = 11000;

function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === DUPLICATE_KEY) {
    // err.keyValue says which field clashed, e.g. { email: "sara@x.com" }.
    // For email we reuse register's exact message, so the app sees ONE message
    // for "email taken", whichever way it was caught.
    const field = Object.keys(err.keyValue || {})[0];
    const message = field === "email" ? "Email already registered" : "This already exists";
    return res.status(409).json({ error: message });
  }

  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Something went wrong" });
}

module.exports = errorHandler;
