const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const parsePagination = require("../utils/pagination");
const parseBooleanQuery = require("../utils/booleanQuery");
const { NOTIFICATION_TYPES } = require("../utils/notificationEvents");

// THE INBOX. Every route here is for the logged-in user's OWN notifications,
// whatever their role (customers, sellers and admins each have an inbox).
//
// The safety rule for this whole file: EVERY query includes
// `recipient: req.user.id`, taken from the login token. There's no way to ask
// for anybody else's inbox, because there's nowhere to say whose.
//
// So someone else's notification id answers 404, not 403. An order is shared by
// three people, so "it exists, but it isn't yours" (403) means something there.
// A notification belongs to exactly ONE person: for everyone else it simply
// doesn't exist, and we shouldn't even confirm that it does.

// One notification of MINE by its id, or a problem to pass to next().
// Shared by "mark as read" and "delete".
async function findMine(req) {
  // A malformed id would make MongoDB throw, and we'd answer 500 instead of 400.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return { problem: { status: 400, message: "Invalid notification id" } };
  }
  const notification = await Notification.findOne({
    _id: req.params.id,
    recipient: req.user.id,
  });
  if (!notification) {
    return { problem: { status: 404, message: "Notification not found" } };
  }
  return { notification };
}

// GET /api/notifications
// My notifications, newest first, paginated.
//   ?unread=true   only unread ones   (?unread=false: only read ones)
//   ?type=order    only one family (one inbox tab)
async function listMyNotifications(req, res, next) {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { recipient: req.user.id };

  // ?unread= must be exactly "true" or "false" (anything else → 400), the same
  // helper every yes/no filter in the dashboards uses.
  const unread = parseBooleanQuery(req.query.unread, "unread");
  if (unread.problem) {
    return next(unread.problem);
  }
  if (unread.value === true) {
    filter.readAt = null; // never read
  } else if (unread.value === false) {
    filter.readAt = { $ne: null }; // read at some point
  }

  // ?type= is checked against the list of families, like ?status= on orders:
  // a misspelt tab name is a real mistake, not something to quietly ignore.
  if (req.query.type) {
    if (!NOTIFICATION_TYPES.includes(req.query.type)) {
      return next({ status: 400, message: "Invalid type" });
    }
    filter.type = req.query.type;
  }

  // Newest first, with _id as the tie-breaker (see the index in the model).
  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Notification.countDocuments(filter),
  ]);

  res.json({ notifications, page, limit, total });
}

// GET /api/notifications/unread-count
// The number on the bell. The app calls this every 30–60 seconds, so it's kept
// as small as possible: one count, answered from an index.
async function getUnreadCount(req, res) {
  const count = await Notification.countDocuments({
    recipient: req.user.id,
    readAt: null,
  });
  res.json({ count });
}

// PATCH /api/notifications/read-all
// Marks every unread notification of mine as read, in one database call.
// `updated` says how many changed (0 if everything was already read).
async function markAllRead(req, res) {
  const result = await Notification.updateMany(
    { recipient: req.user.id, readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ updated: result.modifiedCount });
}

// PATCH /api/notifications/:id/read
// Marks ONE notification of mine as read. Doing it twice is harmless: the
// second time changes nothing and keeps the original readAt, so "when did I
// read it" stays true.
async function markRead(req, res, next) {
  const { problem, notification } = await findMine(req);
  if (problem) {
    return next(problem);
  }

  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }

  res.json({ notification });
}

// DELETE /api/notifications/:id
// Removes ONE notification from my inbox. Reading and deleting are separate:
// marking something read keeps it; only this (or delete-all) removes it.
async function deleteNotification(req, res, next) {
  const { problem, notification } = await findMine(req);
  if (problem) {
    return next(problem);
  }

  await notification.deleteOne();
  res.json({ message: "Notification deleted" });
}

// DELETE /api/notifications
// Empties my whole inbox, read and unread. The filter comes only from the
// token, so this can never touch anyone else's notifications. Calling it on an
// empty inbox is fine: { deleted: 0 }.
async function deleteAllNotifications(req, res) {
  const result = await Notification.deleteMany({ recipient: req.user.id });
  res.json({ deleted: result.deletedCount });
}

module.exports = {
  listMyNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  deleteNotification,
  deleteAllNotifications,
};
