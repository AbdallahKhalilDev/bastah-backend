const mongoose = require("mongoose");

// An Area is one Gaza neighbourhood / town — Rimal, Khan Younis, Nuseirat…
// It's a SMALL FIXED SEEDED LIST, exactly like Category: we insert it once with
// `npm run seed:areas` and it barely ever changes.
//
// WHY IT EXISTS: so that "does this shop deliver to my area?" is a real database
// filter over a shared id, instead of comparing two people's spelling of the same
// place. A seller typing "Al-Rimal", a customer typing "Rimal", and someone else
// typing "الرمال" would never match each other as free text. Once both sides
// point at the SAME Area document, the question becomes a simple lookup.
//
// DELIBERATELY NOT HERE: latitude, longitude, polygons, map tiles. Bastah has no
// map integration. If coordinates are ever wanted, they slot in as extra optional
// fields on this document and nothing built now has to change.
const areaSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    nameAr: {
      type: String,
      required: true,
      trim: true,
    },
    // The stable, human-readable key ("khan-younis"). `unique` is what makes the
    // seed script idempotent: it upserts by slug, so re-running it updates the
    // existing row instead of inserting a second copy. Same trick as Category.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Lets us hide an area from the pickers without deleting it. Deleting would
    // be dangerous: a shop's delivery zone or a past order may still point at
    // this area, and removing the document would leave those pointing at nothing.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// No extra index. The whole collection is ~26 documents, so reading all of them
// is already instant — adding an index here would be cargo-culting. (Contrast
// Shop.deliveryZones.area, which IS indexed, because that filters a collection
// that grows.)
module.exports = mongoose.model("Area", areaSchema);
