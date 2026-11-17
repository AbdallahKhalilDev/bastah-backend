function getHealth(req, res) {
  res.json({ ok: true });
}

// GET /api/health/ip
// Shows the IP address the server believes YOU are calling from. It's for
// checking the "trust proxy" setting in app.js: open it and compare the answer
// with your real public IP (search "what is my IP"). If they match, the rate
// limiter counts each visitor separately, as it should. It only ever shows
// callers their own address, so it reveals nothing about anyone else.
function getMyIp(req, res) {
  res.json({ ip: req.ip });
}

module.exports = { getHealth, getMyIp };
