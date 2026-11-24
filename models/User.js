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
    // A counter that lets us cancel all of this account's existing login tokens.
    // Every token carries the number that was here when it was made. Changing
    // the password adds 1, so every OLDER token now carries the wrong number and
    // the `auth` middleware refuses it: "log out everywhere".
    //
    // Accounts created before this field existed have nothing stored, and the
    // default fills in 0 when they're loaded, so they need no migration.
    tokenVersion: {
      type: Number,
      default: 0,
    },

    // --- Account status (set ONLY by an admin) ------------------------------
    // "active" = can log in and use the app. "suspended" = blocked: login is
    // refused, and every request with an existing token is refused too (the
    // `auth` middleware reads this on every request). Nothing is deleted, so
    // an admin can switch the account back on at any time.
    //
    // Like tokenVersion: accounts created before this field existed have
    // nothing stored, and the default fills in "active" when they're loaded,
    // so no migration script is needed.
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },
    // The admin's reason for the suspension, shown to the user when they're
    // refused. Cleared (back to null) when the account is switched back on.
    statusReason: {
      type: String,
      default: null,
    },
    // WHEN the status last changed, and WHICH admin changed it. That's why
    // every admin needs their own account rather than a shared one.
    statusChangedAt: {
      type: Date,
      default: null,
    },
    statusChangedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // --- Notification settings (the person's own choice) --------------------
    // Two on/off switches, set from the profile page (PATCH /api/auth/me).
    //   offers = shops' offers           alerts = price drops, back in stock,
    //                                             new reviews on my shop
    // Orders, announcements and account notices can't be switched off: they're
    // about the person's own orders and business. notify() (utils/notify.js)
    // reads these before writing an offer or an alert.
    //
    // Both start ON. Accounts created before this field existed have nothing
    // stored; the defaults fill in "on" when they're loaded (the same as
    // tokenVersion and status), and notify() treats "nothing stored" as on too.
    notificationPrefs: {
      type: new mongoose.Schema(
        {
          offers: { type: Boolean, default: true },
          alerts: { type: Boolean, default: true },
        },
        // Part of the user, never addressed on its own: no _id.
        { _id: false }
      ),
      default: () => ({}),
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt` timestamps.
    timestamps: true,
  }
);

// For the admin's user list: "all sellers, newest first" is answered straight
// from this index instead of reading every user. (The list without a role filter
// is newest-first too; with few accounts that's fast either way.)
userSchema.index({ role: 1, createdAt: -1 });

// A "model" is the tool we use to actually read/write Users in the database.
// Mongoose will use the collection named "users" (lowercased + pluralized).
module.exports = mongoose.model("User", userSchema);
