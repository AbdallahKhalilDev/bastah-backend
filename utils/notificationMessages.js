// Every notification's wording, in English AND Arabic, in one file.
//
// Each function returns { title, titleAr, body, bodyAr }, which notify() copies
// onto the notification. The text is written ONCE, when the notification is
// created, and never changes afterwards (a frozen photograph, like an order line).
//
// Names people typed (a shop name, a cancel reason) are shown exactly as they
// were written, in both languages: a shop has only one name, with no Arabic
// version.

// "₪45.00". The ₪ sign is the same in both languages.
function price(n) {
  return `₪${Number(n).toFixed(2)}`;
}

// " Reason: out of stock" / " السبب: out of stock", or nothing when there's no
// reason. Starts with a space so it can be glued onto the end of a sentence.
function reasonText(reason) {
  if (!reason) return { en: "", ar: "" };
  return { en: ` Reason: ${reason}`, ar: ` السبب: ${reason}` };
}

// --- To the SELLER: a customer placed an order at one of their shops ---------
// The shop name is in the text because one seller may own several shops.
// Arabic counts are written as "عدد الأصناف: 3" so we don't have to get Arabic
// plural forms right for every number.
function orderPlaced(order, shopName) {
  const count = order.items.length;
  const isDelivery = order.deliveryMethod === "delivery";
  return {
    title: "New order",
    titleAr: "طلب جديد",
    body:
      `${shopName}: ${count} ${count === 1 ? "item" : "items"}, ` +
      `total ${price(order.total)} (${isDelivery ? "delivery" : "pickup"}).`,
    bodyAr:
      `${shopName}: عدد الأصناف ${count}، المجموع ${price(order.total)} ` +
      `(${isDelivery ? "توصيل" : "استلام من المتجر"}).`,
  };
}

// --- To the CUSTOMER: their order moved on ---------------------------------
// One row per status the order can move TO. "ready" has two versions, because
// it means different things for the two ways of getting your goods:
// pickup → come and collect it; delivery → it's packed and about to leave.
const CUSTOMER_TEXTS = {
  accepted: (shop) => ({
    title: "Order accepted",
    titleAr: "تم قبول طلبك",
    body: `${shop} accepted your order.`,
    bodyAr: `قبل ${shop} طلبك.`,
  }),
  ready_pickup: (shop) => ({
    title: "Ready for pickup",
    titleAr: "طلبك جاهز للاستلام",
    body: `Your order from ${shop} is ready for pickup.`,
    bodyAr: `طلبك من ${shop} جاهز للاستلام.`,
  }),
  ready_delivery: (shop) => ({
    title: "Order packed",
    titleAr: "تم تجهيز طلبك",
    body: `Your order from ${shop} is packed and will leave soon.`,
    bodyAr: `طلبك من ${shop} جاهز وسيخرج للتوصيل قريباً.`,
  }),
  delivering: (shop) => ({
    title: "On its way",
    titleAr: "طلبك في الطريق",
    body: `Your order from ${shop} is on its way.`,
    bodyAr: `طلبك من ${shop} في الطريق إليك.`,
  }),
  completed: (shop) => ({
    title: "Order completed",
    titleAr: "اكتمل طلبك",
    body: `Your order from ${shop} is complete. Thank you!`,
    bodyAr: `اكتمل طلبك من ${shop}. شكراً لك!`,
  }),
  cancelled: (shop, reason) => ({
    title: "Order cancelled",
    titleAr: "تم إلغاء طلبك",
    body: `Your order from ${shop} was cancelled.${reasonText(reason).en}`,
    bodyAr: `تم إلغاء طلبك من ${shop}.${reasonText(reason).ar}`,
  }),
};

function orderStatusForCustomer(order, shopName) {
  let key = order.status;
  if (key === "ready") {
    key = order.deliveryMethod === "delivery" ? "ready_delivery" : "ready_pickup";
  }
  return CUSTOMER_TEXTS[key](shopName, order.cancelReason);
}

// --- To the SELLER: their order moved on, but not by them --------------------
// Only two people besides the seller can move an order: the customer (who may
// only cancel, and only while it's pending) and an admin (who may do anything).
const STATUS_LABELS = {
  accepted: { en: "accepted", ar: "مقبول" },
  ready: { en: "ready", ar: "جاهز" },
  delivering: { en: "on its way", ar: "قيد التوصيل" },
  completed: { en: "completed", ar: "مكتمل" },
  cancelled: { en: "cancelled", ar: "ملغى" },
};

function orderStatusForSeller(order, shopName, actorRole) {
  const reason = order.status === "cancelled" ? reasonText(order.cancelReason) : reasonText();

  if (actorRole === "customer") {
    // The only move a customer can make is cancelling.
    return {
      title: "Order cancelled",
      titleAr: "تم إلغاء طلب",
      body: `A customer cancelled their order at ${shopName} (${price(order.total)}).${reason.en}`,
      bodyAr: `ألغى الزبون طلبه في ${shopName} (${price(order.total)}).${reason.ar}`,
    };
  }

  // An admin moved it.
  const label = STATUS_LABELS[order.status];
  return {
    title: "Order updated by an admin",
    titleAr: "قام المشرف بتحديث طلب",
    body: `An admin marked an order at ${shopName} (${price(order.total)}) as ${label.en}.${reason.en}`,
    bodyAr: `غيّر المشرف حالة طلب في ${shopName} (${price(order.total)}) إلى "${label.ar}".${reason.ar}`,
  };
}

// --- ALERTS ------------------------------------------------------------------

// To a CUSTOMER: something in their cart got cheaper.
function priceDrop(product, shopName, newPrice, oldPrice) {
  return {
    title: "Price drop",
    titleAr: "انخفض السعر",
    body:
      `${product.name} at ${shopName} is now ${price(newPrice)} ` +
      `(was ${price(oldPrice)}). It's in your cart.`,
    bodyAr:
      `${product.nameAr} في ${shopName} أصبح بسعر ${price(newPrice)} ` +
      `(كان ${price(oldPrice)}). المنتج موجود في سلتك.`,
  };
}

// To a CUSTOMER: something in their cart can be bought again.
function backInStock(product, shopName, currentPrice) {
  return {
    title: "Back in stock",
    titleAr: "عاد للتوفر",
    body: `${product.name} at ${shopName} is back in stock, ${price(currentPrice)}. It's in your cart.`,
    bodyAr: `${product.nameAr} في ${shopName} متوفر من جديد بسعر ${price(currentPrice)}. المنتج موجود في سلتك.`,
  };
}

// To a SELLER: one of their shops got a new review. Only the stars, not the
// comment: a comment can be long, and the tap opens the shop's reviews anyway.
function newReview(shopName, rating) {
  return {
    title: "New review",
    titleAr: "تقييم جديد",
    body: `${shopName} got a ${rating}★ review.`,
    bodyAr: `حصل ${shopName} على تقييم ${rating}★.`,
  };
}

module.exports = {
  orderPlaced,
  orderStatusForCustomer,
  orderStatusForSeller,
  priceDrop,
  backInStock,
  newReview,
};
