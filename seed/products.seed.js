// Seeds a batch of demo PRODUCTS so the browse/search pages have enough data to
// page through (with the default limit of 20, you need >20 rows to see a second
// page). Like the categories seed, this is IDEMPOTENT: it upserts on the product
// `name`, so running it twice won't create duplicates, and it leaves any products
// you made by hand (different names) untouched.
//
// Products require a category, so this script attaches each demo product to a
// real category. Run `npm run seed:categories` first if you haven't — this script
// will tell you if no categories exist yet.

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Category = require("../models/Category");
const Product = require("../models/Product");

// 24 demo products, grouped so each of the six seeded categories gets four. Each
// carries an English + Arabic name (bilingual app) and a unit. `categoryName`
// matches a seeded category's English name; we resolve it to that category's id
// below (falling back to the first available category if a name isn't found).
const demoProducts = [
  { name: "Men's T-Shirt", nameAr: "قميص رجالي", unit: "piece", categoryName: "Men" },
  { name: "Men's Jeans", nameAr: "بنطال جينز رجالي", unit: "piece", categoryName: "Men" },
  { name: "Men's Jacket", nameAr: "جاكيت رجالي", unit: "piece", categoryName: "Men" },
  { name: "Men's Sneakers", nameAr: "حذاء رياضي رجالي", unit: "pair", categoryName: "Men" },

  { name: "Women's Dress", nameAr: "فستان نسائي", unit: "piece", categoryName: "Women" },
  { name: "Women's Handbag", nameAr: "حقيبة يد نسائية", unit: "piece", categoryName: "Women" },
  { name: "Women's Scarf", nameAr: "وشاح نسائي", unit: "piece", categoryName: "Women" },
  { name: "Women's Sandals", nameAr: "صندل نسائي", unit: "pair", categoryName: "Women" },

  { name: "Kids' Backpack", nameAr: "حقيبة ظهر للأطفال", unit: "piece", categoryName: "Kids" },
  { name: "Kids' Pajamas", nameAr: "بيجاما أطفال", unit: "piece", categoryName: "Kids" },
  { name: "Kids' Toy Car", nameAr: "سيارة لعبة", unit: "piece", categoryName: "Kids" },
  { name: "Kids' Sneakers", nameAr: "حذاء رياضي للأطفال", unit: "pair", categoryName: "Kids" },

  { name: "Headphones", nameAr: "سماعات رأس", unit: "piece", categoryName: "Electronics & Home" },
  { name: "Bluetooth Speaker", nameAr: "مكبر صوت بلوتوث", unit: "piece", categoryName: "Electronics & Home" },
  { name: "LED Lamp", nameAr: "مصباح ليد", unit: "piece", categoryName: "Electronics & Home" },
  { name: "Power Bank", nameAr: "بطارية متنقلة", unit: "piece", categoryName: "Electronics & Home" },

  { name: "Vitamin C Tablets", nameAr: "أقراص فيتامين سي", unit: "box", categoryName: "Health" },
  { name: "Hand Sanitizer", nameAr: "معقم يدين", unit: "bottle", categoryName: "Health" },
  { name: "First Aid Kit", nameAr: "حقيبة إسعافات أولية", unit: "kit", categoryName: "Health" },
  { name: "Face Mask Pack", nameAr: "علبة كمامات", unit: "pack", categoryName: "Health" },

  { name: "Football", nameAr: "كرة قدم", unit: "piece", categoryName: "Sports" },
  { name: "Yoga Mat", nameAr: "حصيرة يوغا", unit: "piece", categoryName: "Sports" },
  { name: "Dumbbell Set", nameAr: "طقم أثقال", unit: "set", categoryName: "Sports" },
  { name: "Water Bottle", nameAr: "زجاجة ماء", unit: "piece", categoryName: "Sports" },
];

async function seedProducts() {
  await connectDB();

  // Load every category once and index it by English name for quick lookup.
  const categories = await Category.find({});
  if (categories.length === 0) {
    console.error(
      "No categories found. Run `npm run seed:categories` first, then re-run this."
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  const catByName = new Map(categories.map((c) => [c.name, c]));
  const fallbackCat = categories[0]; // used if a product's categoryName isn't found

  for (const p of demoProducts) {
    const category = catByName.get(p.categoryName) || fallbackCat;

    // Idempotent upsert keyed on the product name: update if it already exists,
    // otherwise insert. So re-running this script never piles up duplicates.
    await Product.findOneAndUpdate(
      { name: p.name },
      { $set: { nameAr: p.nameAr, unit: p.unit, category: category._id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  console.log(`Seeded ${demoProducts.length} demo products`);
  await mongoose.disconnect();
}

seedProducts().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
