// Links every product to its image by setting Product.imageUrl.
//
// How the match works: a file in public/images/products/ belongs to the product
// whose English name slugifies to the file's name (minus the extension):
//   "Men's T-Shirt"     -> men-s-t-shirt.webp
//   "Vitamin C Tablets" -> vitamin-c-tablets.webp
// For each product, in this order:
//   1. a file matching its name wins;
//   2. otherwise, if it ALREADY has a photo whose file still exists, it keeps
//      it. That's what happens after a rename (Step 17): "Kids' Toy Car" renamed
//      to "Toy Car (red)" no longer matches kids-toy-car.webp by name, but it
//      should obviously keep its photo;
//   3. otherwise it gets the "no photo yet" placeholder (default.jpg).
// So after this runs, EVERY product has a working imageUrl.
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

// The photo file a stored imageUrl points at, if it's one of our photo files and
// it still exists. Otherwise (the placeholder, a deleted file, anything else) null.
function existingPhotoFile(imageUrl, photoFiles) {
  const prefix = `${PRODUCT_IMAGES_URL}/`;
  if (typeof imageUrl !== "string" || !imageUrl.startsWith(prefix)) return null;
  const file = imageUrl.slice(prefix.length);
  return photoFiles.has(file) ? file : null;
}

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

  // Every usable photo file, for rule 2 ("keep it if its file still exists").
  const photoFiles = new Set(fileBySlug.values());

  await connectDB();
  // .lean() returns the RAW stored documents. Without it, Mongoose fills in the
  // schema default in memory, so a product saved before imageUrl had a default
  // (nothing stored at all) would look "already correct" and never get written.
  const products = await Product.find({}).select("name imageUrl").lean();

  // 2. Work out the path each product SHOULD have, and update only those that differ.
  let updated = 0;
  const withPhoto = [];
  const keptPhoto = [];
  const onDefault = [];
  const matchedSlugs = new Set();

  for (const product of products) {
    const slug = slugify(product.name);
    const file = fileBySlug.get(slug);
    const currentFile = existingPhotoFile(product.imageUrl, photoFiles);
    let imageUrl;

    if (file) {
      // Rule 1: the file named after the product.
      imageUrl = `${PRODUCT_IMAGES_URL}/${file}`;
      matchedSlugs.add(slug);
      withPhoto.push(product.name);
    } else if (currentFile) {
      // Rule 2: no file by name, but its current photo still exists → keep it.
      // That file is in use, so it's "matched" too (no typo warning below).
      imageUrl = product.imageUrl;
      matchedSlugs.add(path.parse(currentFile).name);
      keptPhoto.push(`${product.name} (keeps ${currentFile})`);
    } else {
      // Rule 3: the placeholder.
      imageUrl = DEFAULT_PRODUCT_IMAGE;
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

  console.log(
    `\n${products.length} products: ${withPhoto.length} with their own photo, ` +
      `${keptPhoto.length} kept their photo after a rename, ${onDefault.length} on the placeholder.`
  );
  console.log(`Updated ${updated} product(s) this run.`);
  if (withPhoto.length) console.log(`\nWith a photo:\n  ${withPhoto.join("\n  ")}`);
  if (keptPhoto.length) console.log(`\nKept their photo (renamed since it was linked):\n  ${keptPhoto.join("\n  ")}`);
  if (onDefault.length) console.log(`\nStill on the placeholder (add a file to give them a photo):\n  ${onDefault.join("\n  ")}`);

  await mongoose.disconnect();
}

seedProductImages().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
