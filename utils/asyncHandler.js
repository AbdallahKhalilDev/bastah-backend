// In Express 4, if an `async` controller throws (or a promise rejects), Express
// does NOT catch it automatically — the request would just hang. This little
// wrapper runs your async controller and, if it rejects, forwards the error to
// `next(...)` so our central errorHandler can respond. Wrap every async
// controller with it: `router.post("/x", asyncHandler(myController))`.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
