const mongoose = require("mongoose");

// An Offer is a shop telling its customers about a deal: "20% off rice this
// week", "fresh bread every morning". A seller posts one for their own shop, or
// an admin posts one for any shop. When it's posted, every customer of that shop
// gets a notification, and the offer shows on the shop's page and in the public
// offers list until it ends.
//
// AN OFFER ONLY INFORMS. It never changes a price. The listing's price is the
// real price: to make rice cheaper, the seller lowers the listing's price, and
// the offer just says so. There are no coupons and no discount maths at checkout,
// so orders, priceAtOrder and totals are completely untouched by offers.
const offerSchema = new mongoose.Schema(
  {
    // Which shop the offer is from. Exactly ONE shop: a message for the whole
    // marketplace is an admin announcement, not an offer.
    shop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
    },

    // Optional: the one product the offer is about. When given, it must be a
    // product this shop sells (checked when the offer is posted), so a tap on
    // the offer can open that product's price comparison.
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },

    // The text, in both languages, written by whoever posted it and shown
    // exactly as written.
    title: { type: String, required: true, trim: true },
    titleAr: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    bodyAr: { type: String, required: true, trim: true },

    // When it stops showing. REQUIRED: prices in Gaza change daily, so an offer
    // left running forever would soon be wrong. There's no scheduled job to
    // "end" it: every public list simply asks for offers whose endsAt is still
    // in the future, so an expired offer disappears by itself.
    //
    // There's also no start date: an offer starts the moment it's posted,
    // because that's when its notifications go out.
    endsAt: {
      type: Date,
      required: true,
    },

    // The off switch. Offers are never deleted: old notifications point at
    // them, and a link to a deleted offer would lead nowhere.
    isActive: {
      type: Boolean,
      default: true,
    },

    // Who posted it: the shop's seller, or an admin. Decides who may edit it,
    // and the seller's daily limit counts only the seller's own offers.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// --- Index -------------------------------------------------------------------
// "This shop's offers, newest first". It serves the shop's page, the dashboard
// lists (?shop=), AND the seller's daily limit, which counts this shop's offers
// created since midnight.
offerSchema.index({ shop: 1, createdAt: -1 });

module.exports = mongoose.model("Offer", offerSchema);
