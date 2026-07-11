const express = require("express");
const healthRoutes = require("./routes/health.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

app.use(express.json());

app.use("/api/health", healthRoutes);

app.use((req, res, next) => {
  next({ status: 404, message: "Route not found" });
});

app.use(errorHandler);

module.exports = app;
