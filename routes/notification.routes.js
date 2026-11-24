const express = require("express");
const asyncHandler = require("../utils/asyncHandler");
const auth = require("../middleware/auth");
const {
  listMyNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  deleteNotification,
  deleteAllNotifications,
} = require("../controllers/notification.controller");

const router = express.Router();

// Every route here needs a login, so `auth` is applied ONCE for the whole
// router, like /api/admin and /api/seller. There's no requireRole: customers,
// sellers and admins each have their own inbox. Which notifications you see is
// decided by the controller, from the id in your token.
router.use(auth);

// ROUTE ORDER: the fixed words ("unread-count", "read-all") come BEFORE the
// routes with :id, the same rule as /api/orders/incoming. Today they couldn't
// clash anyway (different methods or lengths), but keeping fixed words first
// means a GET /:id added later can't swallow "unread-count".
router.get("/unread-count", asyncHandler(getUnreadCount)); // the number on the bell
router.patch("/read-all", asyncHandler(markAllRead));

router.get("/", asyncHandler(listMyNotifications)); // ?unread= ?type= ?page= ?limit=
router.delete("/", asyncHandler(deleteAllNotifications)); // empty my whole inbox

router.patch("/:id/read", asyncHandler(markRead));
router.delete("/:id", asyncHandler(deleteNotification));

module.exports = router;
