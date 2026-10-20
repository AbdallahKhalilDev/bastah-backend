// Links every product to its image by setting Product.imageUrl.
//
// How the match works: a file in public/images/products/ belongs to the product
// whose English name slugifies to the file's name (minus the extension):
//   "Men's T-Shirt"     -> men-s-t-shirt.webp
//   "Vitamin C Tablets" -> vitamin-c-tablets.webp
// A product with NO matching file gets the "no photo yet" placeholder
// (default.jpg). So after this runs, EVERY product has a working imageUrl.
//
// Adding photos later is backend-only: drop the file in the folder, re-run this,
// commit, push. The frontend never changes, because it just shows whatever
// imageUrl says.
//
// IDEMPOTENT like the other seeds: it computes the path each product SHOULD have
// and writes only the ones that differ, so a second run changes nothing.
//
// Run it with:  npm run seed:product-images

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Product = require("../models/Product");
const slugify = require("../utils/slugify");
const {
  PRODUCT_IMAGES_URL,
  PRODUCT_IMAGES_DIR,
  DEFAULT_IMAGE_FILE,
  DEFAULT_PRODUCT_IMAGE,
} = require("../utils/productImages");

// Only real image files count (this skips stray files like .DS_Store).
const IMAGE_EXTENSIONS = new Set([".webp", ".jpg", ".jpeg", ".png", ".svg"]);

async function seedProductImages() {
  // 1. Read the folder and index the photos by slug: "football" -> "football.webp".
  //    The placeholder itself is skipped; it isn't any one product's photo.
  const fileBySlug = new Map();
  for (const file of fs.readdirSync(PRODUCT_IMAGES_DIR)) {
    const { name, ext } = path.parse(file);
    if (!IMAGE_EXTENSIONS.has(ext.toLowerCase()) || file === DEFAULT_IMAGE_FILE) continue;

    if (fileBySlug.has(name)) {
      // e.g. both headphones.webp and headphones.jpg: we can't guess which one is meant.
      console.warn(`! Two files for "${name}" (${fileBySlug.get(name)}, ${file}). Keeping the first, remove one.`);
      continue;
    }
    fileBySlug.set(name, file);
  }

  await connectDB();
  // .lean() returns the RAW stored documents. Without it, Mongoose fills in the
  // schema default in memory, so a product saved before imageUrl had a default
  // (nothing stored at all) would look "already correct" and never get written.
  const products = await Product.find({}).select("name imageUrl").lean();

  // 2. Work out the path each product SHOULD have, and update only those that differ.
  let updated = 0;
  const withPhoto = [];
  const onDefault = [];
  const matchedSlugs = new Set();

  for (const product of products) {
    const slug = slugify(product.name);
    const file = fileBySlug.get(slug);
    const imageUrl = file ? `${PRODUCT_IMAGES_URL}/${file}` : DEFAULT_PRODUCT_IMAGE;

    if (file) {
      matchedSlugs.add(slug);
      withPhoto.push(product.name);
    } else {
      onDefault.push(product.name);
    }

    if (product.imageUrl !== imageUrl) {
      await Product.updateOne({ _id: product._id }, { $set: { imageUrl } });
      updated++;
    }
  }

  // 3. Report. A file that matched nothing is almost always a typo in its name.
  const unmatched = [...fileBySlug.entries()].filter(([slug]) => !matchedSlugs.has(slug));
  for (const [slug, file] of unmatched) {
    console.warn(`! ${file} matches no product (looked for a product named like "${slug}"). Check the spelling.`);
  }

  console.log(`\n${products.length} products: ${withPhoto.length} with their own photo, ${onDefault.length} on the placeholder.`);
  console.log(`Updated ${updated} product(s) this run.`);
  if (withPhoto.length) console.log(`\nWith a photo:\n  ${withPhoto.join("\n  ")}`);
  if (onDefault.length) console.log(`\nStill on the placeholder (add a file to give them a photo):\n  ${onDefault.join("\n  ")}`);

  await mongoose.disconnect();
}

seedProductImages().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
