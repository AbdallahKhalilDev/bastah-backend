// A "seed" script inserts a known starter set of rows into the database so the
// app has real data to serve while there's no admin UI to create it by hand.
// We run it once (or after resetting the DB), and re-run it any time we like.
//
// This script is IDEMPOTENT: running it twice leaves the database in the same
// state — it will NOT create duplicates. We achieve that by "upserting" on the
// slug (update the row if that slug already exists, otherwise insert it),
// instead of blindly inserting new rows every time.

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Category = require("../models/Category");
const slugify = require("../utils/slugify"); // "Electronics & Home" -> "electronics-home"

// The six top-level categories from the visual map. Each has an English and an
// Arabic name (the app is bilingual). They're all top-level, so parent = null.
const categories = [
  { name: "Men", nameAr: "رجال" },
  { name: "Women", nameAr: "نساء" },
  { name: "Kids", nameAr: "أطفال" },
  { name: "Electronics & Home", nameAr: "إلكترونيات ومنزل" },
  { name: "Health", nameAr: "صحة" },
  { name: "Sports", nameAr: "رياضة" },
];

async function seedCategories() {
  await connectDB();

  for (const cat of categories) {
    const slug = slugify(cat.name);

    // findOneAndUpdate with upsert: true is the idempotent part.
    //  - filter { slug }: look for an existing category with this slug.
    //  - $set: the fields to write (on both update and insert).
    //  - upsert: true: if none was found, create one.
    //  - setDefaultsOnInsert: apply the schema defaults (isActive: true) on
    //    insert. On insert, slug is taken from the filter automatically.
    await Category.findOneAndUpdate(
      { slug },
      { $set: { name: cat.name, nameAr: cat.nameAr, parent: null } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  console.log(`Seeded ${categories.length} categories`);
  await mongoose.disconnect();
}

seedCategories().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
