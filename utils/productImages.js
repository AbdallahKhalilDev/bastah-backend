// Where product images live, in ONE place, so the Product model's default and the
// image seed can't drift apart.
//
// Product.imageUrl always holds a RELATIVE path like "/images/products/football.webp"
// (never "http://localhost:3000/..."), so the same DB value works locally and on
// Render. The frontend prefixes its API base URL. The files themselves sit in
// public/images/products/ and app.js serves them at /images.
const path = require("path");

// The URL prefix the files are served under (see the express.static line in app.js).
const PRODUCT_IMAGES_URL = "/images/products";

// The folder on disk those URLs map to.
const PRODUCT_IMAGES_DIR = path.join(__dirname, "..", "public", "images", "products");

// The "no photo yet" placeholder. Every product that has no photo of its own
// points here, so the frontend ALWAYS gets a working imageUrl and never needs to
// know which products have real photos.
const DEFAULT_IMAGE_FILE = "default.jpg";
const DEFAULT_PRODUCT_IMAGE = `${PRODUCT_IMAGES_URL}/${DEFAULT_IMAGE_FILE}`;

module.exports = {
  PRODUCT_IMAGES_URL,
  PRODUCT_IMAGES_DIR,
  DEFAULT_IMAGE_FILE,
  DEFAULT_PRODUCT_IMAGE,
};
