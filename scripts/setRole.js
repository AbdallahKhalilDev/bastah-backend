// A tiny DEV/TEST helper — not part of the app the users call.
//
// Register only ever creates a "customer" (the client must never be allowed to
// pick its own role). But to test seller-only features we need a seller. Since
// MongoDB Compass / mongosh aren't installed, this script changes a user's role
// straight from Node, which we already have.
//
// Usage (from the project folder):
//   node scripts/setRole.js sara@example.com seller
//   node scripts/setRole.js someone@example.com admin
//
// It reuses the SAME database connection and User model as the real app, so it
// edits the exact same data your API reads.

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");

// The three roles the app understands (must match the enum in models/User.js).
const ALLOWED_ROLES = ["customer", "seller", "admin"];

async function setRole() {
  // process.argv is the list of words you typed. The first two are always
  // "node" and the script path, so the real arguments start at index 2:
  //   node scripts/setRole.js  sara@example.com  seller
  //   argv[0]      argv[1]           argv[2]       argv[3]
  const email = process.argv[2];
  const role = process.argv[3];

  // Fail early with a helpful message if the command was typed wrong.
  if (!email || !role) {
    console.error("Usage: node scripts/setRole.js <email> <role>");
    console.error("Example: node scripts/setRole.js sara@example.com seller");
    process.exit(1);
  }
  if (!ALLOWED_ROLES.includes(role)) {
    console.error(`Role must be one of: ${ALLOWED_ROLES.join(", ")}`);
    process.exit(1);
  }

  await connectDB();

  // Emails are stored lowercased (see models/User.js), so lowercase here too so
  // the lookup matches regardless of how you type it.
  const result = await User.updateOne(
    { email: email.toLowerCase() },
    { $set: { role } }
  );

  // matchedCount === 0 means no user has that email — likely a typo or they were
  // never registered. Say so clearly instead of pretending it worked.
  if (result.matchedCount === 0) {
    console.error(`No user found with email "${email}". Did you register them?`);
  } else {
    console.log(`Set role of ${email} to "${role}".`);
    console.log("Reminder: that user must LOG IN AGAIN to get a fresh token.");
  }

  await mongoose.disconnect();
}

setRole().catch((err) => {
  console.error("setRole failed:", err.message);
  process.exit(1);
});
