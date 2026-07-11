const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// This one describes a Category — a top-level grouping like "Men", "Women",
// or "Electronics & Home" that shoppers use to browse the marketplace.
const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true, // strips surrounding spaces so " Men " is saved as "Men"
    },
    // The app is bilingual, so every category carries an Arabic name too.
    nameAr: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true, // no two categories can share a slug (adds a DB index)
      lowercase: true, // "Electronics-Home" is stored as "electronics-home"
      trim: true,
    },
    icon: {
      type: String,
      trim: true,
      // optional — no `required`, so a category can exist without an icon
    },
    // A "reference" field: instead of copying a whole parent category inside
    // this one, we store just the parent's _id and tell Mongoose it points at
    // another Category (ref: "Category"). It's like a pointer / foreign key.
    // Later we can call .populate("parent") to swap the id for the full parent
    // document. default: null means "top-level category, no parent."
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    // Lets us hide a category from shoppers without actually deleting it.
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// A "model" is the tool we use to actually read/write Categories in the DB.
// Mongoose will use the collection named "categories" (lowercased + pluralized).
module.exports = mongoose.model("Category", categorySchema);
