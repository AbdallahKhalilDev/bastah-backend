const express = require("express");
const { getHealth, getMyIp } = require("../controllers/health.controller");

const router = express.Router();

router.get("/", getHealth);
router.get("/ip", getMyIp); // the IP the server sees for you (checks trust proxy)

module.exports = router;
