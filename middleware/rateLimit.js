// RATE LIMITING — "how many tries do you get?"
//
// Without a limit, a program could try thousands of passwords on one account
// per minute until one works ("brute force"), or create thousands of fake
// accounts. A rate limiter counts requests and answers 429 ("Too Many
// Requests") once a counter goes over its limit, until the time window is over.
//
// THE GAZA PROBLEM, and why there are TWO limiters:
// Many people in Gaza share ONE public IP address (mobile networks and shared
// internet points put lots of users behind the same address). A simple "10
// tries per IP" rule would let one person's typos lock out everyone in the
// same internet café. So:
//
//   1. failedLoginLimiter: counts only WRONG PASSWORDS, per IP + email. A
//      neighbour on the same IP has a different email, so a separate counter.
//      This is the tight one; it protects each account from guessing.
//   2. authIpLimiter: counts EVERY sign-up/login request per IP, with a much
//      higher limit. It stops one machine from trying one password against
//      MANY accounts, or creating accounts in bulk, while normal shared-IP
//      traffic stays far below it.
//
// The counters live in the server's memory. That's fine for our ONE server on
// Render; they reset when it restarts or falls asleep. With several servers,
// they'd need a shared store (such as Redis).
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// Both limiters count within a 15-minute window.
const WINDOW_MS = 15 * 60 * 1000;

// The limits can be changed with environment variables (no code change), and
// the automated tests use small ones so they can reach them quickly.
function limitFromEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 1. Wrong passwords, per IP + email. Used on all three login pages, as ONE
//    shared counter: switching between the customer, seller and admin pages
//    doesn't give anyone extra guesses.
const failedLoginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: limitFromEnv("LOGIN_MAX_FAILED_ATTEMPTS", 10),

  // The counter's name: the IP plus the email being tried. ipKeyGenerator is
  // the package's helper for the IP part; it handles the long IPv6 addresses
  // that mobile networks use (one phone can own a whole block of them).
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `${ipKeyGenerator(req.ip)}|${email}`;
  },

  // Every attempt is counted when it ARRIVES, then taken off again after the
  // reply if it "succeeded". Here, success = anything except 401. So only
  // real failed guesses stay counted. A form mistake (400), the wrong login
  // page (403, which means the password was RIGHT) and a successful login
  // don't use up anyone's tries.
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,

  // Adds headers that tell the app how long to wait (Retry-After, RateLimit).
  standardHeaders: "draft-8",
  legacyHeaders: false,

  // Over the limit → hand a normal error to our central error handler, so the
  // reply has the usual { error, code } shape. While blocked, even the RIGHT
  // password gets 429: otherwise a guesser could keep going until one
  // "succeeds".
  handler: (req, res, next) =>
    next({
      status: 429,
      message: "Too many failed login attempts. Please wait 15 minutes and try again.",
      code: "too_many_attempts",
    }),
});

// 2. All sign-up and login requests, per IP. Generous on purpose (see the top).
//    Without a keyGenerator, the package counts per IP, using ipKeyGenerator.
const authIpLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: limitFromEnv("AUTH_MAX_REQUESTS", 100),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (req, res, next) =>
    next({
      status: 429,
      message: "Too many requests. Please wait a few minutes and try again.",
      code: "too_many_requests",
    }),
});

module.exports = { failedLoginLimiter, authIpLimiter };
