const Notification = require("../models/Notification");
const User = require("../models/User");
const { EVENT_TYPES } = require("./notificationEvents");

// The two families that go to MANY people at once (broadcasts). They skip
// suspended accounts: a suspended user can't log in to read them, and an
// announcement or offer from weeks ago is stale by the time they're back.
// Everything else (orders, alerts) is about something that really happened to
// that person, so it's still written; it's there if the account is re-opened.
const SKIP_SUSPENDED = ["announcement", "offer"];

// The two families a person can switch off on their profile, and the name of
// the switch for each (User.notificationPrefs). Orders, announcements and
// account notices aren't here: they can't be switched off.
const MUTE_SETTINGS = { offer: "offers", alert: "alerts" };

// The conditions an account must meet to receive this family, as a MongoDB
// filter. Empty {} = no conditions: everyone named gets it.
//
// Both checks use `$ne` ("not equal") rather than asking for the good value,
// because older accounts have nothing stored: no status (made before suspending
// existed) and no notificationPrefs (made before muting existed). `$ne` lets
// those through as "active" and "switched on", which is what they are.
function recipientConditions(type) {
  const conditions = {};
  if (SKIP_SUSPENDED.includes(type)) {
    conditions.status = { $ne: "suspended" };
  }
  if (MUTE_SETTINGS[type]) {
    // e.g. { "notificationPrefs.offers": { $ne: false } }: a dotted path looks
    // INSIDE the notificationPrefs object.
    conditions[`notificationPrefs.${MUTE_SETTINGS[type]}`] = { $ne: false };
  }
  return conditions;
}

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

  // Keep only the people who may receive this family: not suspended (for
  // broadcasts), and not switched off (for offers and alerts). ONE query asks
  // the database "which of these ids meet the conditions?".
  const conditions = recipientConditions(type);
  if (ids.length > 0 && Object.keys(conditions).length > 0) {
    const allowed = await User.find({ _id: { $in: ids }, ...conditions }).select("_id");
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
