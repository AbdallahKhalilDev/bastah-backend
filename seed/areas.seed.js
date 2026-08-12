// Seeds the fixed list of Gaza areas. Same shape as categories.seed.js, and
// IDEMPOTENT for the same reason: we "upsert" on the slug (update the row if that
// slug exists, otherwise insert it), so running this twice leaves the database in
// exactly the same state instead of creating duplicates.
//
// Run it with:  npm run seed:areas

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Area = require("../models/Area");

// The areas, north → south, grouped by governorate. Each has an English and an
// Arabic name because the app is bilingual.
//
// NOTE the deliberate overlap with seed/listings.seed.js: "Rimal", "Downtown",
// "Khan Younis" and "Nuseirat" are exactly the free-text `Shop.area` strings the
// demo shops already use. So after seeding both, every demo shop's physical area
// has a matching Area document and the demo reads coherently — even though the
// two fields aren't linked (see the comment on Shop.deliveryZones).
const areas = [
  // North Gaza
  { name: "Jabalia", nameAr: "جباليا" },
  { name: "Beit Lahia", nameAr: "بيت لاهيا" },
  { name: "Beit Hanoun", nameAr: "بيت حانون" },
  // Gaza City
  { name: "Rimal", nameAr: "الرمال" },
  { name: "Downtown", nameAr: "وسط البلد" },
  { name: "Tel al-Hawa", nameAr: "تل الهوا" },
  { name: "Sheikh Radwan", nameAr: "الشيخ رضوان" },
  { name: "Sheikh Ijlin", nameAr: "الشيخ عجلين" },
  { name: "Zeitoun", nameAr: "الزيتون" },
  { name: "Shujaiya", nameAr: "الشجاعية" },
  { name: "Sabra", nameAr: "الصبرة" },
  { name: "Daraj", nameAr: "الدرج" },
  { name: "Nasser", nameAr: "النصر" },
  { name: "Tuffah", nameAr: "التفاح" },
  // Deir al-Balah (middle governorate)
  { name: "Deir al-Balah", nameAr: "دير البلح" },
  { name: "Nuseirat", nameAr: "النصيرات" },
  { name: "Bureij", nameAr: "البريج" },
  { name: "Maghazi", nameAr: "المغازي" },
  { name: "Zawaida", nameAr: "الزوايدة" },
  // Khan Younis
  { name: "Khan Younis", nameAr: "خان يونس" },
  { name: "Bani Suheila", nameAr: "بني سهيلا" },
  { name: "Abasan", nameAr: "عبسان" },
  { name: "Khuzaa", nameAr: "خزاعة" },
  // Rafah
  { name: "Rafah", nameAr: "رفح" },
  { name: "Tel al-Sultan", nameAr: "تل السلطان" },
  { name: "Shaboura", nameAr: "الشابورة" },
];

// Turn an English name into a URL-safe slug:
//   "Khan Younis" -> "khan-younis"   "Tel al-Hawa" -> "tel-al-hawa"
// (Kept inline here, same as categories.seed.js; we can promote it to utils/
//  later if a create endpoint ever needs the same logic.)
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function seedAreas() {
  await connectDB();

  for (const area of areas) {
    const slug = slugify(area.name);

    // findOneAndUpdate with upsert: true is the idempotent part.
    //  - filter { slug }: look for an existing area with this slug.
    //  - $set: the fields to write (on both update and insert).
    //  - upsert: true: if none was found, create one.
    //  - setDefaultsOnInsert: apply the schema defaults (isActive: true) on
    //    insert. On insert, slug is taken from the filter automatically.
    await Area.findOneAndUpdate(
      { slug },
      { $set: { name: area.name, nameAr: area.nameAr } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  console.log(`Seeded ${areas.length} areas`);
  await mongoose.disconnect();
}

seedAreas().catch((err) => {
  console.error("Seeding failed:", err.message);
  process.exit(1);
});
