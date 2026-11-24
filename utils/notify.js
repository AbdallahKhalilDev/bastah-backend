const Notification = require("../models/Notification");
const { EVENT_TYPES } = require("./notificationEvents");

// notify() is the ONLY way any code creates a notification. That's the same
// "one function does it" habit as recalcShopRating(): if the rules for who gets
// told ever change, there's exactly one place to change them.
//
//   recipients  user ids (ObjectIds or strings) who should be told
//   event       what happened, e.g. "order_accepted" (see notificationEvents.js)
//   message     { title, titleAr, body, bodyAr } from notificationMessages.js
//   link        where a tap should go, e.g. { order, shop }
//   actorId     the user who CAUSED this. They're never told about their own
//               action: a seller who accepts an order doesn't need a
//               notification saying "the order was accepted".
//
// Returns how many notifications it wrote.
//
// IT NEVER THROWS. A notification is a side effect: the order (or whatever
// happened) is what matters, and it has already been saved by the time we get
// here. If writing the notification fails, we log it and carry on, so a
// successful checkout can never turn into an error for the customer just
// because a notification couldn't be written.
async function notify({ recipients, event, message, link = {}, actorId }) {
  try {
    // The family comes from the event table, never from the caller, so the two
    // labels can't disagree. An unknown event is a bug in OUR code: log it.
    const type = EVENT_TYPES[event];
    if (!type) {
      throw new Error(`Unknown notification event "${event}"`);
    }

    // Turn every id into text so we can compare them, drop empty ones and
    // duplicates (a Set keeps one of each), and drop the person who acted.
    const actor = actorId ? String(actorId) : null;
    const ids = [...new Set((recipients || []).filter(Boolean).map(String))].filter(
      (id) => id !== actor
    );
    if (ids.length === 0) {
      return 0;
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
  } catch (err) {
    console.error("notify() could not write a notification:", err.message);
    return 0;
  }
}

module.exports = notify;
