const mongoose = require("mongoose");

// ===========================================================================
// NO MONEY MOVES THROUGH BASTAH.
//
// An Order is a CONNECTION / RESERVATION REQUEST — not an invoice, not a
// receipt for a payment. The customer pays the seller in CASH, IN PERSON,
// offline. Every number on this document is INFORMATIONAL: it is what the two
// sides agreed the goods cost, written down so neither can misremember it.
//
// There is deliberately NO `paid`, no `paymentStatus`, no `paymentMethod`, no
// `transactionId`, and there never will be. If you ever feel tempted to add
// one, that feature belongs outside this app.
// ===========================================================================

// --- ONE LINE of an order -------------------------------------------------
// Compare this with the cart item in models/Cart.js and notice the OPPOSITE
// design choice.
//
// A cart item stores { listing, quantity } and NOTHING else, because a cart is
// a LIVE shortlist — it must always show today's price, so we populate it
// fresh on every read.
//
// An order item stores a full PHOTOGRAPH of the moment the order was placed,
// because an order is HISTORY. It must still read correctly in a year: after
// the shop has changed its price, and even after the listing has been deleted
// outright (DELETE /api/listings/:id is a real endpoint a seller can call).
//
// So each line FREEZES a copy of everything needed to render it:
//   priceAtOrder                    — the agreed unit price in ₪
//   productName / productNameAr / unit — so the line displays with NO populate
//
// We still keep the `listing` and `product` ids for traceability ("which
// listing did this line come from?"), accepting that `listing` may one day
// point at a document that no longer exists. That's fine — nothing reads
// through it to display the order.
const orderItemSchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      required: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // The frozen copies. Required, because a line that can't render itself is
    // useless — and they're always available at checkout, since we read them
    // straight off the populated cart.
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productNameAr: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional, because Product.unit itself is optional ("kg", "L", "piece").
    unit: {
      type: String,
      trim: true,
    },

    // THE FREEZE: the agreed unit price in ₪ at the moment of ordering. Never
    // recomputed, never updated. `min: 0` is the database-level safety net
    // behind the controller's checks — the same "belt and braces" idea as
    // `price: { min: 0 }` on the Listing model.
    priceAtOrder: {
      type: Number,
      required: true,
      min: 0,
    },

    // How many of it. Mirrors the cart item's rule exactly: a whole number, at
    // least 1.
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number",
      },
    },
  },
  // No separate _id per line — exactly like the cart item, and for one extra
  // reason: an order line is a frozen historical row. No endpoint ever
  // addresses a single line, because no endpoint ever CHANGES one. An id would
  // advertise "this is an addressable resource"; its absence says "this is a
  // frozen row inside its parent."
  { _id: false }
);

// --- WHERE a delivery goes ------------------------------------------------
// A structured `area` (a real Area id, so it can be matched against a shop's
// delivery zones) plus free text for the last fifty metres. There is no map
// integration in Bastah, so this is as precise as an address gets — and it's
// plenty for a driver who already knows the neighbourhood.
//
// Like everything else on an order, it's a FROZEN snapshot: if the customer
// later edits their saved address, THIS order still records where it actually
// went. lat/lng would slot in here later without disturbing anything.
const deliveryAddressSchema = new mongoose.Schema(
  {
    area: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Area",
      required: true,
    },
    // "Al-Wehda St, building 12, 3rd floor, next to the pharmacy"
    details: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    // WHO placed it. Always set from the login token, never from the request
    // body — the same rule as Cart.customer and Review.author.
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // WHICH SHOP fulfils it — a SINGLE shop, not an array.
    //
    // A cart may legitimately mix items from several shops; that's the whole
    // price-comparison story. An ORDER cannot: each shop packs, prices and
    // hands over its own goods independently, and a seller must never see
    // another shop's lines. So checkout SPLITS one cart into N orders, one per
    // shop. See POST /api/orders in controllers/order.controller.js.
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },

    // The frozen lines. The `validate` refuses an empty order at the DATABASE
    // level — an order for nothing is meaningless, and this makes it
    // unwritable even if a bug in the controller ever tried.
    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (v) => v.length > 0,
        message: "An order must have at least one item",
      },
    },

    // sum(priceAtOrder × quantity) for this shop's lines, rounded to 2
    // decimals. Stored rather than recomputed on every read, for the same
    // reason as Shop.ratingAvg: reading an order should be one lookup.
    //
    // Unlike ratingAvg, though, this can NEVER drift — it is a snapshot of a
    // sum of snapshots, and nothing it depends on ever changes.
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    // What the customer will hand over in cash: subtotal + deliveryFee.
    //
    // The frontend displays THIS and never has to know the formula. (It was
    // stored from the very first slice, when it merely equalled subtotal,
    // precisely so that adding the fee here changed nothing for the client.)
    total: {
      type: Number,
      required: true,
      min: 0,
    },

    // --- Delivery --------------------------------------------------------
    // pickup   = the customer collects from the shop (everything before Step 13).
    // delivery = the SHOP ITSELF brings it. There is no courier role in Bastah
    //            and nobody to assign — the seller arranges it as they always do.
    //
    // The default is what makes every order created before this feature
    // retroactively and correctly a PICKUP order — which is why adding delivery
    // needed no migration script at all.
    deliveryMethod: {
      type: String,
      enum: ["pickup", "delivery"],
      default: "pickup",
    },

    // Resolved at checkout from the SHOP'S zone for the customer's chosen area,
    // and then FROZEN — exactly like priceAtOrder. A shop may re-price its zones
    // tomorrow; this order must keep saying what was agreed today.
    //
    // Always 0 for pickup. And, like every other number here: INFORMATIONAL.
    // No money moves through this app — the customer hands this to the shop's
    // own person, in cash, on the doorstep.
    deliveryFee: {
      type: Number,
      min: 0,
      default: 0,
    },

    // null for pickup orders; required (enforced in the controller) for delivery.
    deliveryAddress: {
      type: deliveryAddressSchema,
      default: null,
    },

    // Where the order is in its life.
    //
    // `completed` means "THE CUSTOMER HAS THE GOODS". It does NOT mean "paid" —
    // there is no payment in this app. Do not let it drift into meaning that.
    //
    // The legal moves between these values, and who may make each move, live in
    // exactly ONE place: utils/orderQueries.js. This field is deliberately NOT
    // in any zod create-whitelist, so a client can never choose the status its
    // order starts at.
    status: {
      type: String,
      enum: [
        "pending",
        "accepted",
        "ready",
        // Only ever reachable when deliveryMethod === "delivery" — the shop is
        // on its way. Enforced by the transition table, not by this enum.
        "delivering",
        "completed",
        "cancelled",
      ],
      default: "pending",
    },

    // How the seller reaches this customer. Required, because "connect the
    // customer to the seller" IS the product — an order nobody can follow up on
    // is worthless.
    //
    // Taken from the request body rather than copied from User.phone, so a
    // customer can give a different number per order (a relative's phone, a
    // work number). A silently wrong phone here is worse than a 400.
    contactPhone: {
      type: String,
      required: true,
      trim: true,
    },

    // Free text from the customer: "please call before 6pm", "the blue one".
    note: {
      type: String,
      trim: true,
    },

    // Optional free text set alongside a cancellation, so the other side knows
    // why it was cancelled ("out of stock", "changed my mind").
    cancelReason: {
      type: String,
      trim: true,
    },
  },
  {
    // Mongoose auto-adds and maintains `createdAt` and `updatedAt`.
    timestamps: true,
  }
);

// --- Indexes ---------------------------------------------------------------
// An index is a lookup structure MongoDB maintains on the side so it can find
// matching documents without reading every one of them.
//
// These two are COMPOUND (two fields each), and each serves EXACTLY ONE
// endpoint. The trick is putting `createdAt: -1` second: MongoDB can then both
// FILTER and hand back the rows ALREADY IN newest-first order — no in-memory
// sort afterwards, no matter how many orders exist.
//
//   { customer, createdAt } → GET /api/orders          ("my orders")
//   { shop, createdAt }     → GET /api/orders/incoming (Slice 12.2)
//
// Neither is `unique`: a customer may order from the same shop many times.
// Note this makes Order the first write model in Bastah with NO duplicate-key
// path — its 409s come from STATE conflicts, not from the database.
orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ shop: 1, createdAt: -1 });

// A "model" is the tool we use to actually read/write Orders. Mongoose will use
// the collection named "orders" (lowercased + pluralized).
module.exports = mongoose.model("Order", orderSchema);
