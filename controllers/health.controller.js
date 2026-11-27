function getHealth(req, res) {
  res.json({ ok: true });
}

// GET /api/health/ip
// Shows the IP address the server believes YOU are calling from. It's for
// checking the "trust proxy" setting in app.js: open it and compare `ip` with
// your real public IP (search "what is my IP"). If they match, the rate limiter
// counts each visitor separately, as it should.
//
// `forwardedFor` is the raw X-Forwarded-For header. Each proxy ADDS the address
// of whoever connected to it: the first proxy writes your IP, the next one
// writes the first proxy's address, and so on. (Anything to the LEFT of your IP
// was written by the sender and can be fake.) To get the right TRUST_PROXY_HOPS,
// find your IP in the list and count its position from the RIGHT end, where the
// last address is 1. Example: "203.0.113.7, 10.201.3.4" with your IP first →
// 2. (Counting only the addresses AFTER yours gives one too few.) Render doesn't
// document that number, so we measure it. It only ever shows callers their OWN
// request's chain.
function getMyIp(req, res) {
  res.json({
    ip: req.ip,
    forwardedFor: req.headers["x-forwarded-for"] || null,
    trustProxyHops: req.app.get("trust proxy"),
  });
}

module.exports = { getHealth, getMyIp };
