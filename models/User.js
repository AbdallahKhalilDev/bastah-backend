const mongoose = require("mongoose");

// A "schema" is the shape/blueprint of a document in a MongoDB collection.
// It says which fields a User has, their types, and the rules for each.
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true, // strips surrounding spaces so " Sara " is saved as "Sara"
    },
    email: {
      type: String,
      required: true,
      unique: true, // no two users can share an email (adds a DB index)
      lowercase: true, // "Sara@X.com" is stored as "sara@x.com" so lookups match
      trim: true,
    },
    // We NEVER store the raw password. Only the bcrypt hash of it goes here.
    passwordHash: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    role: {
      type: String,
      enum: ["customer", "seller", "admin"], // only these 3 values are allowed
      default: "customer", // new users are customers unless told otherwise
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// A "model" is the tool we use to actually read/write Users in the database.
// Mongoose will use the collection named "users" (lowercased + pluralized).
module.exports = mongoose.model("User", userSchema);
