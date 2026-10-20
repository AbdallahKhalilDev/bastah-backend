const path = require("path");
const express = require("express");
const cors = require("cors");
const healthRoutes = require("./routes/health.routes");
const authRoutes = require("./routes/auth.routes");
const categoryRoutes = require("./routes/category.routes");
const areaRoutes = require("./routes/area.routes");
const shopRoutes = require("./routes/shop.routes");
const productRoutes = require("./routes/product.routes");
const listingRoutes = require("./routes/listing.routes");
const reviewRoutes = require("./routes/review.routes");
const cartRoutes = require("./routes/cart.routes");
const orderRoutes = require("./routes/order.routes");
const homeRoutes = require("./routes/home.routes");
const searchRoutes = require("./routes/search.routes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Allow all origins for now so any frontend can call the API during development.
// TODO: restrict `origin` to the real frontend URL before/at production launch.
app.use(cors({ origin: true }));

app.use(express.json());

// Product images are plain files committed to git under public/images/, so they
// ship with every deploy (Render only wipes files written WHILE the server runs).
// express.static is Express's built-in file server: GET /images/products/x.webp
// returns public/images/products/x.webp with the right Content-Type. No controller
// needed. The DB stores only the relative path in Product.imageUrl.
// maxAge "7d" lets phones/browsers keep an image for a week instead of re-downloading
// it — it saves Render bandwidth. So when REPLACING a photo, give it a new file name.
// A missing file falls through to the 404 handler below.
app.use(
  "/images",
  express.static(path.join(__dirname, "public", "images"), { maxAge: "7d" })
);

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/areas", areaRoutes);
app.use("/api/shops", shopRoutes);
app.use("/api/products", productRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/home", homeRoutes);
app.use("/api/search", searchRoutes);

app.use((req, res, next) => {
  next({ status: 404, message: "Route not found" });
});

app.use(errorHandler);

module.exports = app;

