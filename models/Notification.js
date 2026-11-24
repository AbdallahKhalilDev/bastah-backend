const mongoose = require("mongoose");
const {
  NOTIFICATION_TYPES,
  NOTIFICATION_EVENTS,
} = require("../utils/notificationEvents");

// A Notification is ONE entry in ONE person's inbox: "your order was accepted",
// "you have a new order". When something happens, the backend writes one of
// these for each person who should know. Nothing is sent anywhere: the app
// simply asks the server every 30–60 seconds how many unread ones there are.
//
// Like an order line, a notification is a FROZEN photograph: its text is
// written once, when it's created, and never changes. So the inbox needs no
// populate at all, and an old notification still reads correctly after the
// shop renames itself or the product is deleted.

// --- Where a tap should take the user -------------------------------------
// Plain ids only. We never populate them: the text already says everything,
// and the app uses these just to open the right screen (the order, the shop…).
// Every field is optional, because each kind of notification fills in only the
// ones it needs (an order notification sets `order` and `shop`).
// `offer` points at a model that a later slice (15.4) adds; a `ref` is only a
// name, so that's fine until then.
const linkSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    shop: { type: mongoose.Schema.Types.ObjectId, ref: "Shop" },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing" },
    offer: { type: mongoose.Schema.Types.ObjectId, ref: "Offer" },
  },
  // A link is part of its notification, never addressed on its own: no _id.
  { _id: false }
);

const notificationSchema = new mongoose.Schema(
  {
    // Whose inbox this is. Every inbox endpoint filters on this, using the id
    // from the login token, so nobody can ever read someone else's.
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // The family (the inbox tab) and the exact event. See
    // utils/notificationEvents.js for the lists and why there are two labels.
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    event: {
      type: String,
      enum: NOTIFICATION_EVENTS,
      required: true,
    },

    // The text, in BOTH languages, written once by utils/notificationMessages.js.
    // The app shows title/body in English mode and titleAr/bodyAr in Arabic mode.
    title: { type: String, required: true, trim: true },
    titleAr: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    bodyAr: { type: String, required: true, trim: true },

    // Where a tap goes. Defaults to an empty object rather than nothing, so the
    // app can always read notification.link.order without checking first.
    link: {
      type: linkSchema,
      default: () => ({}),
    },

    // null = unread. We store WHEN it was read (a date) rather than a plain
    // true/false: it answers "is it read?" just as easily, and also "since when?".
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    // createdAt orders the inbox (newest first).
    timestamps: true,
  }
);

// --- Indexes: one per job (the same habit as Order) -----------------------
//
// 1. The inbox list: "my notifications, newest first".
//    `_id` is a tie-breaker. One checkout can create several notifications in
//    the same millisecond, so createdAt alone can't put them in a fixed order,
//    and then page 1 and page 2 could repeat or skip one. An _id is unique and
//    grows over time, so sorting by createdAt THEN _id is always the same order.
notificationSchema.index({ recipient: 1, createdAt: -1, _id: -1 });

// 2. The unread count: "how many of mine have no readAt?". This is the endpoint
//    the app calls every 30–60 seconds, so it gets its own index to stay cheap.
notificationSchema.index({ recipient: 1, readAt: 1 });

// Mongoose will use the collection named "notifications".
module.exports = mongoose.model("Notification", notificationSchema);
