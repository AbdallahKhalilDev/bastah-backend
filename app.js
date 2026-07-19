const express = require("express");
const cors = require("cors");
const healthRoutes = require("./routes/health.routes");
const authRoutes = require("./routes/auth.routes");
const categoryRoutes = require("./routes/category.routes");
const shopRoutes = require("./routes/shop.routes");
const productRoutes = require("./routes/product.routes");
const listingRoutes = require("./routes/listing.routes");
const reviewRoutes = require("./routes/review.routes");
const cartRoutes = require("./routes/cart.routes");
const homeRoutes = require("./routes/home.routes");
const searchRoutes = require("./routes/search.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Allow all origins for now so any frontend can call the API during development.
// TODO: restrict `origin` to the real frontend URL before/at production launch.
app.use(cors({ origin: true }));

app.use(express.json());

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/shops", shopRoutes);
app.use("/api/products", productRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/search", searchRoutes);

app.use((req, res, next) => {
  next({ status: 404, message: "Route not found" });
});

app.use(errorHandler);

module.exports = app;
