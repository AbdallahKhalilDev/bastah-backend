const { z } = require("zod");
const User = require("../models/User");
const { sendNotifications } = require("../utils/notify");

// ANNOUNCEMENTS: an admin writes one message, and it lands in the inbox of
// everyone they chose. There's no Announcement model: an announcement IS the
// set of notifications it creates, one per person.

// Who each audience means. Admins are never in any of them: they're the ones
// writing announcements, not reading them.
const AUDIENCE_ROLES = {
  all: ["customer", "seller"],
  customers: ["customer"],
  sellers: ["seller"],
};

// A WHITELIST, in both languages, like every other notification. The admin
// writes the text; we show it exactly as written. Same limits as product names
// (100) and descriptions (1000).
const announcementSchema = z.object({
  title: z
    .string({ error: "Title is required" })
    .trim()
    .min(1, "Title is required")
    .max(100, "Title is too long (max 100 characters)"),
  titleAr: z
    .string({ error: "Arabic title is required" })
    .trim()
    .min(1, "Arabic title is required")
    .max(100, "Arabic title is too long (max 100 characters)"),
  body: z
    .string({ error: "Message is required" })
    .trim()
    .min(1, "Message is required")
    .max(1000, "Message is too long (max 1000 characters)"),
  bodyAr: z
    .string({ error: "Arabic message is required" })
    .trim()
    .min(1, "Arabic message is required")
    .max(1000, "Arabic message is too long (max 1000 characters)"),
  // Leaving it out means everyone (customers and sellers).
  audience: z
    .enum(["all", "customers", "sellers"], {
      error: "Audience must be all, customers or sellers",
    })
    .default("all"),
});

// POST /api/admin/announcements
// Admin only (checked once for the whole /api/admin router).
// Replies 201 { audience, sent }: `sent` is how many inboxes it reached.
async function sendAnnouncement(req, res, next) {
  const result = announcementSchema.safeParse(req.body);
  if (!result.success) {
    return next({ status: 400, message: result.error.issues[0].message });
  }
  const { title, titleAr, body, bodyAr, audience } = result.data;

  // Everyone with one of the chosen roles. We fetch only their ids.
  const users = await User.find({ role: { $in: AUDIENCE_ROLES[audience] } }).select("_id");

  // sendNotifications, NOT notify: here the notifications ARE the action, so if
  // writing them fails, the admin must get an error instead of a quiet
  // "sent: 0". It skips suspended accounts by itself (announcements are a
  // broadcast; see utils/notify.js).
  const sent = await sendNotifications({
    recipients: users.map((u) => u._id),
    event: "announcement",
    message: { title, titleAr, body, bodyAr },
    actorId: req.user.id,
  });

  res.status(201).json({ audience, sent });
}

module.exports = { sendAnnouncement };
