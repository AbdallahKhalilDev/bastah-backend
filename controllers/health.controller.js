function getHealth(req, res) {
  res.json({ ok: true });
}

// GET /api/health/ip
// Shows the IP address the server believes YOU are calling from. It's for
// checking the "trust proxy" setting in app.js: open it and compare `ip` with
// your real public IP (search "what is my IP"). If they match, the rate limiter
// counts each visitor separately, as it should.
//
// `forwardedFor` is the raw X-Forwarded-For header: your IP, then one address
// added by each proxy on the way in. Counting the proxy addresses after yours
// gives the right TRUST_PROXY_HOPS. (Render doesn't document that number, so
// we measure it.) It only ever shows callers their OWN request's chain.
function getMyIp(req, res) {
  res.json({
    ip: req.ip,
    forwardedFor: req.headers["x-forwarded-for"] || null,
    trustProxyHops: req.app.get("trust proxy"),
  });
}

module.exports = { getHealth, getMyIp };
