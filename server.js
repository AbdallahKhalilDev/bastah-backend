require("dotenv").config();
const { missingEnv } = require("./config/env");

// Stop right here if a required setting is missing (see config/env.js), BEFORE
// anything else loads. process.exit(1) means "ended with an error", so Render
// shows the deploy as failed instead of running a half-working server.
const missing = missingEnv();
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("Add them to .env (locally) or to the Render dashboard (production).");
  process.exit(1);
}

const app = require("./app");
const connectDB = require("./config/db");

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
