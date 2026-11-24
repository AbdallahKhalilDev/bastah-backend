const Notification = require("../models/Notification");
const User = require("../models/User");
const { EVENT_TYPES } = require("./notificationEvents");

// The two families that go to MANY people at once (broadcasts). They skip
// suspended accounts: a suspended user can't log in to read them, and an
// announcement or offer from weeks ago is stale by the time they're back.
// Everything else (orders, alerts) is about something that really happened to
// that person, so it's still written; it's there if the account is re-opened.
const SKIP_SUSPENDED = ["announcement", "offer"];

// sendNotifications() does the actual work of writing notifications.
//
//   recipients     user ids (ObjectIds or strings) who should be told
//   event          what happened, e.g. "order_accepted" (see notificationEvents.js)
//   message        { title, titleAr, body, bodyAr } from notificationMessages.js
//   link           where a tap should go, e.g. { order, shop }
//   actorId        the user who CAUSED this. They're never told about their own
//                  action: a seller who accepts an order doesn't need a
//                  notification saying "the order was accepted".
//   replaceUnread  true → "one unread alert per item": first delete each
//                  recipient's UNREAD notification of the same family about the
//                  same listing, then write the fresh one. Used by price alerts,
//                  so three price drops in a row leave ONE alert showing the
//                  latest price, not three.
//
// Returns how many notifications it wrote. Unlike notify() below, it DOES throw
// when something goes wrong. Use it only where the notification IS the action
// (an admin's announcement), so a failure reaches the admin as an error.
async function sendNotifications({
  recipients,
  event,
  message,
  link = {},
  actorId,
  replaceUnread = false,
}) {
  // The family comes from the event table, never from the caller, so the two
  // labels can't disagree. An unknown event is a bug in OUR code.
  const type = EVENT_TYPES[event];
  if (!type) {
    throw new Error(`Unknown notification event "${event}"`);
  }

  // Turn every id into text so we can compare them, drop empty ones and
  // duplicates (a Set keeps one of each), and drop the person who acted.
  const actor = actorId ? String(actorId) : null;
  let ids = [...new Set((recipients || []).filter(Boolean).map(String))].filter(
    (id) => id !== actor
  );

  // Broadcasts: keep only accounts that aren't suspended. `$ne` ("not equal")
  // rather than `status: "active"`, because accounts made before suspending
  // existed have no status stored at all, and they count as active.
  if (ids.length > 0 && SKIP_SUSPENDED.includes(type)) {
    const allowed = await User.find({
      _id: { $in: ids },
      status: { $ne: "suspended" },
    }).select("_id");
    ids = allowed.map((u) => String(u._id));
  }

  if (ids.length === 0) {
    return 0;
  }

  // The "collapse" rule: remove the older unread alert about this same listing
  // before writing the new one. Read ones are left alone (they're history), so
  // once you've seen an alert, the next price drop is a new one.
  if (replaceUnread && link.listing) {
    await Notification.deleteMany({
      recipient: { $in: ids },
      type,
      "link.listing": link.listing,
      readAt: null,
    });
  }

  // One document per recipient, all written in ONE database call.
  const docs = ids.map((recipient) => ({
    recipient,
    type,
    event,
    title: message.title,
    titleAr: message.titleAr,
    body: message.body,
    bodyAr: message.bodyAr,
    link,
  }));
  await Notification.insertMany(docs);
  return docs.length;
}

// notify() is what almost every caller uses: the same thing, but it NEVER
// THROWS. A notification is usually a side effect: the order (or price change,
// or review) is what matters, and it has already been saved by the time we get
// here. If writing the notification fails, we log it and carry on, so a
// successful checkout can never turn into an error for the customer just
// because a notification couldn't be written.
//
// Both functions are the ONLY ways to create a notification, the same "one
// function does it" habit as recalcShopRating().
async function notify(options) {
  try {
    return await sendNotifications(options);
  } catch (err) {
    console.error("notify() could not write a notification:", err.message);
    return 0;
  }
}

module.exports = { notify, sendNotifications };
