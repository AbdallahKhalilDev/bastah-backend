// The settings the server cannot work without. They come from `.env` locally,
// and from the Render dashboard in production.
//
// Why check them at startup? Without JWT_SECRET or JWT_EXPIRES_IN, the server
// would START fine and look healthy, then fail with a 500 the first time
// someone tries to log in. It's much better to refuse to start at all, with a
// message that names exactly what's missing.
const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET", "JWT_EXPIRES_IN"];

// Returns the names of the required settings that are missing or empty.
// It takes `env` as a parameter (instead of reading process.env directly) so the
// tests can hand it a fake set of settings.
function missingEnv(env = process.env) {
  return REQUIRED_ENV.filter((name) => !env[name] || !env[name].trim());
}

module.exports = { REQUIRED_ENV, missingEnv };
