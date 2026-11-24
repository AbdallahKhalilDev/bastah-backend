// The list of notification kinds, in ONE place.
//
// Every notification has two labels:
//
//   type  = the FAMILY it belongs to. It decides which tab of the inbox it sits
//           in, and (in a later slice) what a user can mute. ?type= on
//           GET /api/notifications filters by it.
//   event = WHAT EXACTLY happened ("the order was accepted", "it's on its way").
//           The app uses it to pick an icon or a colour.
//
// EVENT_TYPES maps each event to its family. Code that creates a notification
// passes only the event, and notify() (utils/notify.js) looks the family up
// here, so the two labels can never disagree.
//
// Each slice of Step 15 adds only its own rows to EVENT_TYPES, the same way
// Step 13 added one "delivering" row to the order TRANSITIONS table.

// All five families. They're the inbox tabs, so they're all listed from the
// start: ?type=alert is a valid question today, it just has no answers yet.
const NOTIFICATION_TYPES = ["order", "alert", "announcement", "account", "offer"];

const EVENT_TYPES = {
  // Slice 15.1: orders.
  order_placed: "order", // → the shop's owner: a customer placed an order
  order_accepted: "order",
  order_ready: "order",
  order_delivering: "order",
  order_completed: "order",
  order_cancelled: "order",

  // Slice 15.2: alerts and announcements.
  price_drop: "alert", // → customers with that item in their cart
  back_in_stock: "alert", // → customers with that item in their cart
  new_review: "alert", // → the shop's owner
  announcement: "announcement", // → everyone an admin chose (never admins)

  // Slice 15.3: account notices. An admin changed something a seller owns.
  // These can't be muted: they're about the seller's own business.
  shop_locked: "account", // → the shop's owner, with the admin's reason
  shop_unlocked: "account",
  shop_verified: "account",
  shop_unverified: "account",
  product_hidden: "account", // → the product's creator + every seller who lists it
  product_shown: "account",
};

// Just the event names, for the model's enum.
const NOTIFICATION_EVENTS = Object.keys(EVENT_TYPES);

module.exports = { NOTIFICATION_TYPES, EVENT_TYPES, NOTIFICATION_EVENTS };
