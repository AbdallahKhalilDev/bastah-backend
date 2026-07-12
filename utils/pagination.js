// Turns the raw ?page and ?limit query strings into safe numbers we can trust,
// plus the `skip` value MongoDB needs. Used by any endpoint that returns a long
// list in pages (product browse, product search…).
//
// Query params arrive as STRINGS ("2", "999", "abc", or missing entirely), so we
// parse and then SANITIZE rather than reject: a missing value falls back to a
// default, and a silly value is clamped into a sensible range. That "fix it, don't
// error" behaviour is right for a browse endpoint — asking for limit=999 should
// just give you the max, not a 400. (We still use zod to strictly validate write
// BODIES elsewhere; that's untrusted data we create records from.)
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parsePagination(query) {
  // parseInt("abc", 10) is NaN, and so is parseInt(undefined). We catch that and
  // fall back to the default/first page.
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);

  // page: at least 1 (no page 0 or negative pages).
  if (!Number.isFinite(page) || page < 1) page = 1;

  // limit: at least 1, never more than MAX_LIMIT (protects the DB from someone
  // asking for a million rows at once).
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  // skip = how many documents to jump over to reach this page. Page 1 skips 0,
  // page 2 skips `limit`, page 3 skips `2 * limit`, and so on.
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}

module.exports = parsePagination;
