// Makes an ADMIN account from the command line.
//
// There is no admin sign-up page, on purpose. So the very FIRST admin can only be
// made here. After that, admins create more admins from the admin dashboard
// (POST /api/admin/users), and this script is rarely needed.
//
// Usage (from the project folder):
//   npm run create-admin -- <email> "<name>" <phone>
// Example:
//   npm run create-admin -- admin@bastah.ps "Abdallah Khalil" 0599000000
//
// It makes up a strong random password and prints it ONCE. Copy it, log in on the
// admin page, then change it (PATCH /api/auth/me/password).
//
// ⚠ It writes to whatever database MONGO_URI points at. Your .env currently ends
// with the Atlas line, i.e. the LIVE database, which is exactly where the real
// first admin belongs. The script prints the database before writing anything,
// so you always see where it went.
//
// It goes through the SAME createAccount() as every sign-up (utils/accounts.js),
// so the same rules apply: a valid email, one email = one account, and the
// password stored only as a hash.

require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { accountSchema, createAccount } = require("../utils/accounts");

async function createAdmin() {
  // process.argv holds the words you typed; the real arguments start at index 2:
  //   node scripts/createAdmin.js  admin@x.ps  "Name"  0599...
  //   argv[0]      argv[1]            argv[2]    argv[3]  argv[4]
  const [email, name, phone] = process.argv.slice(2);
  if (!email || !name || !phone) {
    console.error('Usage: npm run create-admin -- <email> "<name>" <phone>');
    console.error('Example: npm run create-admin -- admin@bastah.ps "Abdallah Khalil" 0599000000');
    process.exit(1);
  }

  // A random password: 12 random bytes, written as 16 letters, digits, - and _.
  // `crypto` is built into Node and made for secrets (Math.random() is not).
  const password = crypto.randomBytes(12).toString("base64url");

  // Check the input with the SAME rules as every new account, before connecting.
  const result = accountSchema.safeParse({ name, email, phone, password });
  if (!result.success) {
    console.error(result.error.issues[0].message);
    process.exit(1);
  }

  await connectDB();
  console.log(`Database: "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  const { problem, user } = await createAccount({ ...result.data, role: "admin" });
  if (problem) {
    // We never touch an existing account here, so it can't silently turn a
    // customer or a seller into an admin.
    if (problem.status === 409) {
      console.error(`An account with the email "${email}" already exists. Nothing was changed.`);
      console.error("To make an EXISTING account an admin, use: node scripts/setRole.js <email> admin");
    } else {
      console.error(problem.message);
    }
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Admin created: ${user.email} (${user.name})`);
  console.log(`  Password: ${password}`);
  console.log("This password is shown only ONCE. Log in on the admin page and change it.");

  await mongoose.disconnect();
}

createAdmin().catch((err) => {
  console.error("create-admin failed:", err.message);
  process.exit(1);
});
